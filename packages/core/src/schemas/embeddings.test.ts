import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmbeddingProfileSchema,
  embeddingJobProgressSchema,
  embeddingProviderConfigSchema,
} from "./embeddings";

const providerConfig = {
  baseUrl: "https://embeddings.example.com/v1",
  model: "embed-small",
  dimensions: 768,
  secretRef: "env:EMBEDDING_API_KEY",
};

test("embedding profiles are opt-in and scope-safe", () => {
  const profile = createEmbeddingProfileSchema.parse({
    name: "global-default",
    scope: "global",
    ...providerConfig,
  });

  assert.equal(profile.enabled, false);
  assert.equal(profile.provider, "openai_compatible");
  assert.equal(profile.batchSize, 64);
  assert.equal(profile.chunkSize, 1200);

  assert.equal(createEmbeddingProfileSchema.safeParse({
    name: "invalid-project",
    scope: "project",
    ...providerConfig,
  }).success, false);
  assert.equal(createEmbeddingProfileSchema.safeParse({
    name: "leaky-global",
    scope: "global",
    projectId: "00000000-0000-4000-8000-000000000001",
    ...providerConfig,
  }).success, false);
});

test("provider configuration requires references instead of raw secrets", () => {
  assert.equal(embeddingProviderConfigSchema.safeParse({
    ...providerConfig,
    secretRef: "sk-raw-secret",
  }).success, false);
  assert.equal(embeddingProviderConfigSchema.safeParse({
    ...providerConfig,
    baseUrl: "https://user:password@example.com/v1",
  }).success, false);
});

test("embedding job progress cannot over-count work", () => {
  assert.equal(embeddingJobProgressSchema.safeParse({
    totalItems: 2,
    pendingItems: 1,
    completedItems: 2,
    failedItems: 0,
    skippedItems: 0,
    promptTokens: 10,
  }).success, false);
});
