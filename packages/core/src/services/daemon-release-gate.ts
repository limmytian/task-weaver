import { createHash } from "node:crypto";
import type {
  DaemonReleaseEvidence,
  DaemonReleaseGateInput,
  DaemonReleaseInvariant,
  DaemonSloMetricId,
} from "@task-weaver/contracts";

export type {
  DaemonRealSmokeEvidence,
  DaemonReleaseEvidence,
  DaemonReleaseGateInput,
  DaemonReleaseInvariant,
} from "@task-weaver/contracts";

function invariant(
  id: string,
  title: string,
  source: DaemonReleaseInvariant["source"],
  passed: boolean,
  evidence: string,
): DaemonReleaseInvariant {
  return { id, title, source, passed, evidence };
}

export function buildDaemonReleaseEvidence(input: DaemonReleaseGateInput): DaemonReleaseEvidence {
  const smokeAgeMs = new Date(input.generatedAt ?? new Date()).getTime() - new Date(input.realSmoke.completedAt).getTime();
  const providers = new Set(input.realSmoke.providers);
  const commitMatches = input.realSmoke.commitSha === input.commitSha;
  const smokeCoverage = providers.has("github")
    && providers.has("gitea")
    && input.realSmoke.requirementIds.length >= 2
    && input.realSmoke.deliveries >= 4
    && input.realSmoke.approvals >= input.realSmoke.deliveries
    && input.realSmoke.cleanedUp
    && smokeAgeMs >= 0
    && smokeAgeMs <= 24 * 3_600_000
    && commitMatches;
  const sloMetrics = new Map(input.slo.metrics.map((metric) => [metric.id, metric]));
  const sloPass = (id: DaemonSloMetricId) => sloMetrics.get(id)?.status === "pass";
  const deterministicEvidence = input.deterministicGate.passed
    ? `Passed ${input.deterministicGate.command} at ${input.commitSha}.`
    : `Failed or missing ${input.deterministicGate.command} evidence.`;
  const smokeEvidence = smokeCoverage
    ? `${input.realSmoke.requirementIds.length} Requirements, ${input.realSmoke.deliveries} deliveries, ${input.realSmoke.approvals} independent approvals, cleanup complete.`
    : `Smoke evidence is incomplete, stale, not from ${input.commitSha}, or lacks GitHub/Gitea coverage.`;

  const invariants: DaemonReleaseInvariant[] = [
    invariant("single_owner", "One live Requirement lane has at most one owner", "deterministic", input.deterministicGate.passed, deterministicEvidence),
    invariant("generation_fencing", "Stale generations cannot mutate tasks, slices, repositories, or Requirement state", "deterministic", input.deterministicGate.passed, deterministicEvidence),
    invariant("heartbeat_fencing", "Heartbeat uncertainty fences writes and process death becomes safely reclaimable", "deterministic", input.deterministicGate.passed, deterministicEvidence),
    invariant("bounded_retry", "API, database, Git, credential, AI, check, and forge outcomes route to bounded recovery", "deterministic", input.deterministicGate.passed, deterministicEvidence),
    invariant("partial_delivery", "Multi-repository partial success survives conflict and follow-up execution", "deterministic", input.deterministicGate.passed, deterministicEvidence),
    invariant("real_ai_forges", "Real AI, credential brokers, protected GitHub/Gitea PRs, and independent approvals complete", "real_smoke", smokeCoverage, smokeEvidence),
    invariant("disposable_cleanup", "Disposable Task Weaver and forge resources are cleaned up", "real_smoke", input.realSmoke.cleanedUp, smokeEvidence),
    invariant("acquisition_health", "Acquisition and heartbeat objectives have current passing evidence", "slo", sloPass("acquisition_latency_p95") && sloPass("heartbeat_gap_p99"), `SLO window ${input.slo.windowStart}–${input.slo.windowEnd}.`),
    invariant("completion_health", "Completion has no stranded lanes", "slo", sloPass("completion_rate") && sloPass("stranded_lanes"), `SLO window ${input.slo.windowStart}–${input.slo.windowEnd}.`),
    invariant("review_merge_health", "Review and merge latency objectives have current passing evidence", "slo", sloPass("review_duration_p95") && sloPass("merge_latency_p95"), `SLO window ${input.slo.windowStart}–${input.slo.windowEnd}.`),
    invariant("no_critical_alerts", "No critical daemon production alerts are firing", "slo", input.slo.alerts.every((alert) => alert.severity !== "critical") && input.slo.releaseStatus === "pass", `${input.slo.alerts.length} active alerts; release status ${input.slo.releaseStatus}.`),
  ];
  const blockers = invariants.filter((entry) => !entry.passed).map((entry) => `${entry.id}: ${entry.evidence}`);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const digestInput = JSON.stringify({
    schemaVersion: 1,
    commitSha: input.commitSha,
    generatedAt,
    deterministicGate: input.deterministicGate,
    realSmoke: input.realSmoke,
    slo: input.slo,
    invariants,
    blockers,
  });
  return {
    schemaVersion: 1,
    commitSha: input.commitSha,
    generatedAt,
    decision: blockers.length === 0 ? "ready" : "blocked",
    evidenceDigest: createHash("sha256").update(digestInput).digest("hex"),
    deterministicGate: input.deterministicGate,
    realSmoke: input.realSmoke,
    slo: input.slo,
    invariants,
    blockers,
  };
}
