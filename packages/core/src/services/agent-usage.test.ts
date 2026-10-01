import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileUsage,
  normalizeOutcomeSummary,
  type UsageRun,
} from "./agent-usage";
const summary = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 80,
  cacheWriteTokens: null,
  cacheSemantics: "included" as const,
  provider: "unknown",
  model: "multiple",
  completeness: "partial" as const,
};
const row: UsageRun = {
  processId: "process",
  projectId: "project",
  requirementId: "req",
  taskId: null,
  daemonId: "daemon",
  piRunId: null,
  attempt: null,
  source: "codex_jsonl",
  agent: "codex",
  phase: "execution",
  outcome: "running",
  startedAt: new Date(0),
  endedAt: null,
  revision: 1,
  summary,
  reportedBy: "reporter",
  updatedAt: new Date(0),
};
test("snapshots are replacements, replay and stale reports do not add totals", () => {
  assert.equal(reconcileUsage(row, { ...row, summary: { ...summary } }), null);
  assert.equal(reconcileUsage(row, { ...row, revision: 0 }), null);
  assert.equal(
    reconcileUsage(row, {
      ...row,
      revision: 2,
      summary: { ...summary, inputTokens: 200 },
    })?.summary.inputTokens,
    200,
  );
  assert.throws(() =>
    reconcileUsage(row, { ...row, summary: { ...summary, inputTokens: 200 } }),
  );
  assert.throws(() =>
    reconcileUsage(row, {
      ...row,
      revision: 2,
      summary: { ...summary, inputTokens: 0 },
    }),
  );
});
test("scope, reporter, attempt and terminal identity are immutable", () => {
  for (const field of [
    "projectId",
    "requirementId",
    "taskId",
    "reportedBy",
    "piRunId",
    "daemonId",
  ])
    assert.throws(() =>
      reconcileUsage(row, { ...row, [field]: "other", revision: 2 }),
    );
  const terminal = { ...row, outcome: "failed" as const, endedAt: new Date(1) };
  assert.throws(() => reconcileUsage(terminal, { ...row, revision: 2 }));
  assert.equal(
    normalizeOutcomeSummary(
      { ...summary, completeness: "complete" },
      "cancelled",
    ).completeness,
    "partial",
  );
});
