import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  embeddingProviderConfigSchema,
  type EmbeddingProviderConfig,
} from "@task-weaver/contracts";
import {
  EmbeddingProviderError,
  type EmbeddingBatchResult,
  type EmbeddingProvider,
  type EmbeddingProviderCapabilities,
  type EmbeddingProviderObserver,
  type EmbeddingRequest,
  type EmbeddingSecretResolver,
  type EmbeddingUsage,
} from "./provider";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleEmbeddingProviderOptions {
  fetch?: FetchLike;
  resolveSecret: EmbeddingSecretResolver;
  observer?: EmbeddingProviderObserver;
  now?: () => number;
}

export function resolveEmbeddingSecretReference(secretRef: string, signal: AbortSignal) {
  if (signal.aborted) throw new EmbeddingProviderError("Embedding secret resolution was aborted", {
    code: "aborted",
  });
  const envName = /^env:([A-Z_][A-Z0-9_]*)$/i.exec(secretRef)?.[1];
  if (!envName) {
    throw new EmbeddingProviderError("No local resolver is configured for this secret reference", {
      code: "authentication",
    });
  }
  const value = process.env[envName];
  if (!value) {
    throw new EmbeddingProviderError("Embedding secret reference is not available", {
      code: "authentication",
    });
  }
  return value;
}

const embeddingResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
    index: z.number().int().nonnegative(),
  })),
  model: z.string().optional(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

const errorStatusMap: Record<number, {
  code: ConstructorParameters<typeof EmbeddingProviderError>[1]["code"];
  retryable: boolean;
}> = {
  400: { code: "invalid_request", retryable: false },
  401: { code: "authentication", retryable: false },
  403: { code: "permission", retryable: false },
  408: { code: "timeout", retryable: true },
  409: { code: "invalid_request", retryable: false },
  429: { code: "rate_limited", retryable: true },
};

function validateConfig(config: EmbeddingProviderConfig) {
  const parsed = embeddingProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new EmbeddingProviderError("Invalid embedding provider configuration", {
      code: "invalid_config",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function endpointFor(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings") ? normalized : `${normalized}/embeddings`;
}

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function combineAbortSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("embedding provider request timed out"));
  }, timeoutMs);

  const abortFromParent = () => {
    parentAborted = true;
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    didAbort: () => parentAborted,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function parseUsage(usage: z.infer<typeof embeddingResponseSchema>["usage"]): EmbeddingUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    totalTokens: usage.total_tokens,
  };
}

function validateVectors(
  data: z.infer<typeof embeddingResponseSchema>["data"],
  expectedCount: number,
  expectedDimensions: number,
) {
  if (data.length !== expectedCount) {
    throw new EmbeddingProviderError("Embedding provider returned an unexpected vector count", {
      code: "invalid_response",
    });
  }

  const sorted = [...data].sort((left, right) => left.index - right.index);
  for (const [position, item] of sorted.entries()) {
    if (item.index !== position || item.embedding.length !== expectedDimensions) {
      throw new EmbeddingProviderError("Embedding provider returned incompatible vectors", {
        code: "invalid_response",
      });
    }
    if (item.embedding.some((component) => !Number.isFinite(component))) {
      throw new EmbeddingProviderError("Embedding provider returned a non-finite vector", {
        code: "invalid_response",
      });
    }
  }
  return sorted;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly config: Readonly<EmbeddingProviderConfig>;
  private readonly fetch: FetchLike;
  private readonly resolveSecret: EmbeddingSecretResolver;
  private readonly observer?: EmbeddingProviderObserver;
  private readonly now: () => number;

  constructor(
    config: EmbeddingProviderConfig,
    options: OpenAICompatibleEmbeddingProviderOptions,
  ) {
    this.config = validateConfig(config);
    this.fetch = options.fetch ?? fetch;
    this.resolveSecret = options.resolveSecret;
    this.observer = options.observer;
    this.now = options.now ?? Date.now;
  }

  async validateConfiguration(options: { signal?: AbortSignal } = {}) {
    const result = await this.embed({
      operationId: `validate-${randomUUID()}`,
      signal: options.signal,
      inputs: [{ id: "configuration-probe", text: "Task Weaver embedding capability probe" }],
    });
    return {
      provider: "openai_compatible" as const,
      model: result.model,
      dimensions: result.vectors[0]?.embedding.length ?? this.config.dimensions,
      maxBatchSize: this.config.batchSize,
    } satisfies EmbeddingProviderCapabilities;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingBatchResult> {
    const inputs = [...request.inputs];
    if (inputs.length === 0) {
      throw new EmbeddingProviderError("Embedding request must contain at least one input", {
        code: "invalid_request",
      });
    }
    const seenIds = new Set<string>();
    for (const input of inputs) {
      if (!input.id || seenIds.has(input.id) || input.text.length === 0) {
        throw new EmbeddingProviderError("Embedding request contains an invalid input", {
          code: "invalid_request",
        });
      }
      seenIds.add(input.id);
    }

    const operationId = request.operationId ?? randomUUID();
    const vectors = [];
    const requestIds: string[] = [];
    let model = this.config.model;
    let usage: EmbeddingUsage | undefined;
    for (let offset = 0, batchIndex = 0; offset < inputs.length; offset += this.config.batchSize, batchIndex += 1) {
      const batch = inputs.slice(offset, offset + this.config.batchSize);
      const result = await this.embedBatch(batch, {
        operationId,
        batchIndex,
        signal: request.signal,
      });
      vectors.push(...result.vectors);
      requestIds.push(...result.requestIds);
      model = result.model;
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + (result.usage?.promptTokens ?? 0),
        totalTokens: (usage?.totalTokens ?? 0) + (result.usage?.totalTokens ?? 0),
      };
    }

    return { vectors, model, usage, requestIds };
  }

  private async embedBatch(
    inputs: EmbeddingRequest["inputs"],
    context: { operationId: string; batchIndex: number; signal?: AbortSignal },
  ): Promise<EmbeddingBatchResult> {
    const startedAt = this.now();
    const startedDate = new Date(startedAt);
    this.observer?.onRequest?.({
      operationId: context.operationId,
      batchIndex: context.batchIndex,
      inputCount: inputs.length,
      startedAt: startedDate,
    });

    const abort = combineAbortSignals(context.signal, this.config.timeoutMs);
    try {
      const secret = await this.resolveSecret(this.config.secretRef, abort.signal);
      if (!secret || secret.trim().length === 0) {
        throw new EmbeddingProviderError("Embedding provider secret reference resolved to an empty value", {
          code: "authentication",
          retryable: false,
        });
      }
      const response = await this.fetch(endpointFor(this.config.baseUrl), {
        method: "POST",
        signal: abort.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: inputs.map((input) => input.text),
          dimensions: this.config.dimensions,
          encoding_format: "float",
        }),
      });

      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        const mapped = errorStatusMap[response.status]
          ?? (response.status >= 500
            ? { code: "unavailable" as const, retryable: true }
            : { code: "unknown" as const, retryable: false });
        throw new EmbeddingProviderError(
          `Embedding provider request failed with HTTP ${response.status}`,
          {
            code: mapped.code,
            retryable: mapped.retryable,
            status: response.status,
            requestId,
            retryAfterMs: response.status === 429
              ? parseRetryAfter(response.headers.get("retry-after"), this.now())
              : undefined,
          },
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw new EmbeddingProviderError("Embedding provider returned malformed JSON", {
          code: "invalid_response",
          requestId,
          cause,
        });
      }
      const parsed = embeddingResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new EmbeddingProviderError("Embedding provider returned an invalid response", {
          code: "invalid_response",
          requestId,
          cause: parsed.error,
        });
      }

      const sorted = validateVectors(parsed.data.data, inputs.length, this.config.dimensions);
      const result: EmbeddingBatchResult = {
        vectors: sorted.map((item) => ({
          id: inputs[item.index]!.id,
          embedding: item.embedding,
        })),
        model: parsed.data.model ?? this.config.model,
        usage: parseUsage(parsed.data.usage),
        requestIds: requestId ? [requestId] : [],
      };
      this.observer?.onSuccess?.({
        operationId: context.operationId,
        batchIndex: context.batchIndex,
        inputCount: inputs.length,
        durationMs: Math.max(0, this.now() - startedAt),
        requestId,
        promptTokens: result.usage?.promptTokens,
      });
      return result;
    } catch (cause) {
      let error: EmbeddingProviderError;
      if (cause instanceof EmbeddingProviderError) {
        error = cause;
      } else if (abort.didTimeout()) {
        error = new EmbeddingProviderError("Embedding provider request timed out", {
          code: "timeout",
          retryable: true,
          cause,
        });
      } else if (abort.didAbort()) {
        error = new EmbeddingProviderError("Embedding provider request was aborted", {
          code: "aborted",
          retryable: false,
          cause,
        });
      } else {
        error = new EmbeddingProviderError("Embedding provider request failed", {
          code: "network",
          retryable: true,
          cause,
        });
      }
      this.observer?.onError?.({
        operationId: context.operationId,
        batchIndex: context.batchIndex,
        inputCount: inputs.length,
        durationMs: Math.max(0, this.now() - startedAt),
        code: error.code,
        retryable: error.retryable,
        status: error.status,
      });
      throw error;
    } finally {
      abort.dispose();
    }
  }
}

export function createOpenAICompatibleEmbeddingProvider(
  config: EmbeddingProviderConfig,
  options: OpenAICompatibleEmbeddingProviderOptions,
) {
  return new OpenAICompatibleEmbeddingProvider(config, options);
}
