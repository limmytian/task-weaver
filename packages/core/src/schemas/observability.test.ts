import assert from "node:assert/strict";
import test from "node:test";
import {
  isProgressTransitionValid,
  redactObservabilityAttributes,
  redactObservabilityText,
  observabilityNextActionSchema,
} from "./observability";

test("redacts secrets and bounds structured observability attributes", () => {
  const result = redactObservabilityAttributes({
    authorization: "Bearer super-secret-token",
    output: "x".repeat(20_000),
    nested: { apiKey: "tw_secret" },
  });
  assert.equal(result.value.authorization, "[redacted]");
  assert.deepEqual((result.value.nested as Record<string, unknown>).apiKey, "[redacted]");
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result.value).length <= 9_000);
});

test("redacts bearer values and reports truncation", () => {
  const result = redactObservabilityText("Bearer abc123 " + "z".repeat(20), 16);
  assert.match(result.value, /^Bearer \[redact/);
  assert.equal(result.truncated, true);
});

test("recognizes valid progress transitions and marks terminal phases", () => {
  assert.equal(isProgressTransitionValid("claiming", "executing"), true);
  assert.equal(isProgressTransitionValid("executing", "completed"), false);
  assert.equal(isProgressTransitionValid("completed", "executing"), false);
  assert.equal(isProgressTransitionValid(undefined, "claiming"), true);
});

test("requires explainable forecast metadata and preserves unknown confidence", () => {
  const forecast = observabilityNextActionSchema.parse({
    kind: "operator",
    reason: "Inspect a stalled worker",
    trigger: "lastEventAt>5m ago",
    policy: "no-progress-manual-recovery",
    at: null,
    nextActionAt: null,
    confidence: "unknown",
    blockingEntity: { kind: "worker", id: null, label: "Worker 2" },
    requiredRole: "operator",
    requiredCapability: "daemon.recovery",
    requirementId: null,
    taskId: null,
    daemonId: "00000000-0000-4000-8000-000000000001",
    workerIndex: 2,
  });
  assert.equal(forecast.confidence, "unknown");
  assert.equal(forecast.blockingEntity?.label, "Worker 2");
  assert.equal(forecast.requiredCapability, "daemon.recovery");
});
