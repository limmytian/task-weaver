import type { EmbeddingProviderConfig } from "@task-weaver/contracts";

export type EmbeddingProviderErrorCode =
  | "invalid_config"
  | "authentication"
  | "permission"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "unavailable"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "unknown";

export interface EmbeddingProviderErrorOptions {
  code: EmbeddingProviderErrorCode;
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  requestId?: string;
  cause?: unknown;
}

export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(message: string, options: EmbeddingProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

export interface EmbeddingInput {
  id: string;
  text: string;
}

export interface EmbeddingRequest {
  inputs: readonly EmbeddingInput[];
  signal?: AbortSignal;
  operationId?: string;
}

export interface EmbeddingVector {
  id: string;
  embedding: number[];
}

export interface EmbeddingUsage {
  promptTokens?: number;
  totalTokens?: number;
}

export interface EmbeddingBatchResult {
  vectors: EmbeddingVector[];
  model: string;
  usage?: EmbeddingUsage;
  requestIds: string[];
}

export interface EmbeddingProviderCapabilities {
  provider: "openai_compatible";
  model: string;
  dimensions: number;
  maxBatchSize: number;
}

export interface EmbeddingProviderObserver {
  onRequest?(event: {
    operationId: string;
    batchIndex: number;
    inputCount: number;
    startedAt: Date;
  }): void;
  onSuccess?(event: {
    operationId: string;
    batchIndex: number;
    inputCount: number;
    durationMs: number;
    requestId?: string;
    promptTokens?: number;
  }): void;
  onError?(event: {
    operationId: string;
    batchIndex: number;
    inputCount: number;
    durationMs: number;
    code: EmbeddingProviderErrorCode;
    retryable: boolean;
    status?: number;
  }): void;
}

export type EmbeddingSecretResolver = (
  secretRef: string,
  signal: AbortSignal,
) => Promise<string> | string;

export interface EmbeddingProvider {
  readonly config: Readonly<EmbeddingProviderConfig>;
  embed(request: EmbeddingRequest): Promise<EmbeddingBatchResult>;
  validateConfiguration(options?: { signal?: AbortSignal }): Promise<EmbeddingProviderCapabilities>;
}
