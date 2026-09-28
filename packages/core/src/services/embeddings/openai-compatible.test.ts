import assert from "node:assert/strict";
import test from "node:test";
import {
  EmbeddingProviderError,
  createOpenAICompatibleEmbeddingProvider,
  type EmbeddingProviderObserver,
} from "./index";

const baseConfig = {
  provider: "openai_compatible" as const,
  baseUrl: "https://embeddings.example.com/v1",
  model: "embed-small",
  dimensions: 3,
  secretRef: "env:EMBEDDING_API_KEY",
  timeoutMs: 500,
  batchSize: 2,
};

function response(payload: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("OpenAI-compatible adapter resolves secrets at call time and preserves vector order", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const observerEvents: unknown[] = [];
  const observer: EmbeddingProviderObserver = {
    onRequest: (event) => observerEvents.push(event),
    onSuccess: (event) => observerEvents.push(event),
  };
  const provider = createOpenAICompatibleEmbeddingProvider(baseConfig, {
    resolveSecret: (reference) => {
      assert.equal(reference, "env:EMBEDDING_API_KEY");
      return "secret-value";
    },
    observer,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return response({
        model: "embed-small-v2",
        data: [
          { index: 1, embedding: [0.2, 0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }, 200, { "x-request-id": "req-1" });
    },
  });

  const result = await provider.embed({
    operationId: "op-1",
    inputs: [
      { id: "first", text: "first text" },
      { id: "second", text: "second text" },
    ],
  });

  assert.equal(calls[0]?.url, "https://embeddings.example.com/v1/embeddings");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer secret-value");
  assert.deepEqual(result.vectors.map((vector) => vector.id), ["first", "second"]);
  assert.deepEqual(result.vectors[1]?.embedding, [0.2, 0.3, 0.4]);
  assert.equal(result.model, "embed-small-v2");
  assert.equal(result.usage?.promptTokens, 7);
  assert.equal(result.requestIds[0], "req-1");
  assert.equal(JSON.stringify(observerEvents).includes("first text"), false);
});

test("adapter batches inputs and aggregates usage", async () => {
  let requestCount = 0;
  const provider = createOpenAICompatibleEmbeddingProvider(baseConfig, {
    resolveSecret: () => "secret",
    fetch: async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return response({
        data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0] })),
        usage: { prompt_tokens: body.input.length },
      });
    },
  });

  const result = await provider.embed({
    inputs: [
      { id: "1", text: "one" },
      { id: "2", text: "two" },
      { id: "3", text: "three" },
    ],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.vectors.length, 3);
  assert.equal(result.usage?.promptTokens, 3);
});

test("rate limits are normalized without exposing provider response bodies", async () => {
  const provider = createOpenAICompatibleEmbeddingProvider(baseConfig, {
    resolveSecret: () => "secret",
    fetch: async () => response({ error: { message: "secret input should not leak" } }, 429, {
      "retry-after": "2",
    }),
  });

  await assert.rejects(
    provider.embed({ inputs: [{ id: "1", text: "text" }] }),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingProviderError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.message.includes("secret input"), false);
      return true;
    },
  );
});

test("malformed dimensions and timeout become actionable provider errors", async () => {
  const malformed = createOpenAICompatibleEmbeddingProvider(baseConfig, {
    resolveSecret: () => "secret",
    fetch: async () => response({
      data: [{ index: 0, embedding: [1, 2] }],
    }),
  });
  await assert.rejects(
    malformed.embed({ inputs: [{ id: "1", text: "text" }] }),
    (error: unknown) => error instanceof EmbeddingProviderError && error.code === "invalid_response",
  );

  const timedOut = createOpenAICompatibleEmbeddingProvider({ ...baseConfig, timeoutMs: 100 }, {
    resolveSecret: () => "secret",
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(
    timedOut.embed({ inputs: [{ id: "1", text: "text" }] }),
    (error: unknown) => error instanceof EmbeddingProviderError && error.code === "timeout",
  );
});
