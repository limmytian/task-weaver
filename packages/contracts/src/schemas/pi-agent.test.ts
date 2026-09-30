import assert from "node:assert";
import { test } from "node:test";
import {
  createPiAgentRunSchema,
  TI_SERVER_AGENT_ID,
  resolvePiModelSchema,
  upsertPiAgentPolicySchema,
  upsertPiModelConfigSchema,
} from "./pi-agent";

test("Ti agent schemas", async (t) => {
  await t.test("defaults queued runs to the bounded server agent", () => {
    const parsed = createPiAgentRunSchema.parse({
      taskId: "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(parsed.assignedAgentId, TI_SERVER_AGENT_ID);
    assert.equal(parsed.assignedAgentType, "agent");
    assert.equal(parsed.maxRetries, undefined);
  });

  await t.test("rejects runs without an explicit task or schedule run target", () => {
    const parsed = createPiAgentRunSchema.safeParse({});
    assert.equal(parsed.success, false);
  });

  await t.test("accepts owner-scoped model configuration", () => {
    const parsed = upsertPiModelConfigSchema.parse({
      provider: "openai",
      model: "gpt-5.4-mini",
      baseUrl: "https://api.openai.com/v1",
      isDefault: true,
      credentialStatus: "valid",
    });
    assert.equal(parsed.provider, "openai");
    assert.equal(parsed.baseUrl, "https://api.openai.com/v1");
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.isDefault, true);
  });

  await t.test("allows requested model resolution input to be empty for default fallback", () => {
    const parsed = resolvePiModelSchema.parse({});
    assert.equal(parsed.requestedPiProvider, undefined);
    assert.equal(parsed.requestedPiModel, undefined);
  });

  await t.test("rejects enabled policy with disabled execution mode", () => {
    const parsed = upsertPiAgentPolicySchema.safeParse({
      enabled: true,
      executionMode: "disabled",
    });
    assert.equal(parsed.success, false);
  });

  await t.test("accepts dry-run execution policy with limits", () => {
    const parsed = upsertPiAgentPolicySchema.parse({
      enabled: true,
      executionMode: "dry_run",
      maxConcurrentRuns: 2,
      dailyRunLimit: 10,
      monthlyRunLimit: 100,
      runTimeoutSeconds: 120,
      defaultMaxRetries: 1,
    });
    assert.equal(parsed.executionMode, "dry_run");
    assert.equal(parsed.maxConcurrentRuns, 2);
  });
});
