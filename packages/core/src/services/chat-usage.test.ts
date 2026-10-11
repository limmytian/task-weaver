import assert from "node:assert/strict";
import test from "node:test";
import { snapshotChatModel, providerChatUsage } from "./chat-usage";
import type { tiAgentModelConfigs } from "@task-weaver/db";

test("snapshots allowlist configuration fields and preserve historical attribution", () => {
  const config = { id: "11111111-1111-4111-8111-111111111111", updatedAt: new Date(0),
    label: "Model secret", provider: "gateway", model: "model-v1", encryptedApiKey: "ciphertext",
    baseUrl: "https://secret@example.com", proxyUrl: "http://secret@proxy", costMetadata: { secret: "secret" } } as unknown as typeof tiAgentModelConfigs.$inferSelect;
  const snapshot = snapshotChatModel(config, { temperature: 0.2 }, "secret", new Date(1));
  config.model = "model-v2";
  assert.equal(snapshot.configuredModel, "model-v1");
  assert.equal(snapshot.displayName, "Model [redacted]");
  assert.equal(snapshot.capturedAt, new Date(1).toISOString());
  assert.ok(!JSON.stringify(snapshot).includes("ciphertext"));
  assert.ok(!JSON.stringify(snapshot).includes("example.com"));
  assert.deepEqual(snapshot.generation, { temperature: 0.2 });
});

test("provider counters preserve complete, partial and unknown coverage", () => {
  assert.equal(providerChatUsage(null).completeness, "unknown");
  assert.equal(providerChatUsage({ prompt_tokens: 0 }).completeness, "partial");
  const complete = providerChatUsage({ prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 80 } }, "actual-model");
  assert.equal(complete.completeness, "complete");
  assert.equal(complete.cacheReadTokens, 80);
  assert.equal(complete.cacheWriteTokens, null);
  assert.equal(complete.model, "actual-model");
  assert.equal(providerChatUsage({ prompt_tokens: -1, completion_tokens: 1.5 }).completeness, "unknown");
});
