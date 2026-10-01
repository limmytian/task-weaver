import assert from "node:assert/strict";
import test from "node:test";
import { agentUsageSummarySchema, reportAgentUsageSchema } from "./agent-usage";
test("missing counters remain unknown; explicit zero is reported", () => {
  assert.equal(
    agentUsageSummarySchema.parse({ completeness: "unknown" }).inputTokens,
    null,
  );
  assert.equal(
    agentUsageSummarySchema.parse({
      completeness: "complete",
      inputTokens: 0,
      outputTokens: 0,
    }).inputTokens,
    0,
  );
  for (const data of [
    { completeness: "complete" },
    { completeness: "unknown", inputTokens: 0 },
    { completeness: "partial" },
    { completeness: "partial", inputTokens: -1 },
    { completeness: "partial", inputTokens: 1.2 },
    { completeness: "partial", inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(agentUsageSummarySchema.safeParse(data).success, false);
});
test("cache overlap is explicit and payloads are rejected", () => {
  assert.equal(
    agentUsageSummarySchema.safeParse({
      completeness: "partial",
      inputTokens: 5,
      cacheReadTokens: 6,
      cacheSemantics: "included",
    }).success,
    false,
  );
  assert.equal(
    agentUsageSummarySchema.safeParse({
      completeness: "partial",
      inputTokens: 5,
      cacheReadTokens: 6,
      cacheSemantics: "additional",
    }).success,
    true,
  );
  assert.equal(
    agentUsageSummarySchema.safeParse({
      completeness: "unknown",
      prompt: "secret",
    }).success,
    false,
  );
  assert.equal(
    reportAgentUsageSchema.safeParse({ transcript: "secret" }).success,
    false,
  );
});
