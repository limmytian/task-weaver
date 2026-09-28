import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { embeddingBaseUrlSchema, embeddingProviderConfigSchema, embeddingSecretReferenceSchema } from "../../schemas/embeddings";
import { EmbeddingProviderError, resolveEmbeddingSecretReference } from "./index";

test("embedding configuration accepts opaque references but rejects credential-bearing endpoints", () => {
  assert.equal(embeddingSecretReferenceSchema.safeParse("env:OPENAI_API_KEY").success, true);
  assert.equal(embeddingSecretReferenceSchema.safeParse("sk-raw-secret").success, false);
  assert.equal(embeddingBaseUrlSchema.safeParse("https://user:pass@example.com/v1").success, false);
  assert.equal(embeddingProviderConfigSchema.safeParse({
    baseUrl: "https://example.com/v1",
    model: "embed-small",
    dimensions: 3,
    secretRef: "env:OPENAI_API_KEY",
  }).success, true);
});

test("default secret resolver fails closed and preserves the error taxonomy", () => {
  assert.throws(
    () => resolveEmbeddingSecretReference("file:/tmp/key", new AbortController().signal),
    (error: unknown) => error instanceof EmbeddingProviderError && error.code === "authentication",
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => resolveEmbeddingSecretReference("env:OPENAI_API_KEY", controller.signal),
    (error: unknown) => error instanceof EmbeddingProviderError && error.code === "aborted",
  );
});

test("rollout migrations keep mixed dimensions isolated in generation-owned HNSW indexes", async () => {
  const foundationUrl = new URL("../../../../db/drizzle/0042_embedding_foundation.sql", import.meta.url);
  const hnswUrl = new URL("../../../../db/drizzle/0043_embedding_generation_hnsw.sql", import.meta.url);
  const [foundation, hnsw] = await Promise.all([
    readFile(foundationUrl, "utf8"),
    readFile(hnswUrl, "utf8"),
  ]);
  assert.doesNotMatch(foundation, /USING hnsw/);
  assert.match(foundation, /enforce_embedding_generation_immutability/);
  assert.match(foundation, /validate_document_embedding/);
  assert.match(hnsw, /DROP INDEX IF EXISTS "task_weaver"\."idx_document_embeddings_hnsw_cosine"/);
  assert.match(hnsw, /USING hnsw/);
  assert.match(hnsw, /vector_cosine_ops/);
  assert.match(hnsw, /WHERE "generation_id" = %L::uuid/);
  assert.match(hnsw, /embedding_generation_create_hnsw_index/);
  assert.match(hnsw, /embedding_generation_drop_hnsw_index/);
});
