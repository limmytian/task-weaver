import assert from "node:assert/strict";
import test from "node:test";
import { reviewPolicyInputSchema } from "@task-weaver/contracts";
import {
  DEFAULT_REVIEW_POLICY,
  assertIndependentDeliveryIdentity,
  evaluateReviewPolicy,
  resolveReviewPolicy,
} from "./reviews";

const strictPolicy = reviewPolicyInputSchema.parse({
  requiredChecks: ["typecheck", "unit"],
  requireAiReview: true,
  minimumHumanApprovals: 2,
  requireIndependentReviewer: true,
  requireIndependentMerger: true,
  allowedMergeModes: ["provider", "manual"],
  defaultMergeMode: "provider",
  baseBranch: "main",
  retryPolicy: { maxAttempts: 4, initialBackoffSeconds: 30, maxBackoffSeconds: 600 },
  allowManualOverride: true,
  overrideRequiresReason: true,
});

const executor = { actorId: "executor", actorType: "agent" as const, daemonId: "daemon-executor" };
const reviewer = { actorId: "reviewer", actorType: "agent" as const, daemonId: "daemon-reviewer" };
const merger = { actorId: "merger", actorType: "agent" as const, daemonId: "daemon-merger" };

test("review policy schema rejects ambiguous checks and merge mode configuration", () => {
  assert.equal(reviewPolicyInputSchema.safeParse({ requiredChecks: ["lint", "lint"] }).success, false);
  assert.equal(reviewPolicyInputSchema.safeParse({
    allowedMergeModes: ["manual"],
    defaultMergeMode: "provider",
  }).success, false);
  assert.equal(reviewPolicyInputSchema.safeParse({
    retryPolicy: { maxAttempts: 3, initialBackoffSeconds: 60, maxBackoffSeconds: 30 },
  }).success, false);
});

test("built-in review policy remains backward compatible and identifies its source", () => {
  assert.deepEqual(resolveReviewPolicy("project-1"), {
    ...DEFAULT_REVIEW_POLICY,
    source: "built_in",
    id: null,
    projectId: "project-1",
    requirementId: null,
  });
});

test("review evaluation requires named checks, current-commit decisions, approvals, and independent identities", () => {
  const evaluation = evaluateReviewPolicy(strictPolicy, {
    headCommit: "abcdef123456",
    checks: [
      { name: "typecheck", status: "passed" },
      { name: "unit", status: "passed" },
    ],
    findings: [],
    decisions: [
      {
        kind: "ai",
        decision: "approved",
        headCommit: "abcdef123456",
        actorId: "reviewer",
        actorType: "agent",
        daemonId: "daemon-reviewer",
        reason: null,
      },
      {
        kind: "human",
        decision: "approved",
        headCommit: "abcdef123456",
        actorId: "human-1",
        actorType: "human",
        daemonId: null,
        reason: null,
      },
      {
        kind: "human",
        decision: "approved",
        headCommit: "abcdef123456",
        actorId: "human-2",
        actorType: "human",
        daemonId: null,
        reason: null,
      },
      {
        kind: "human",
        decision: "changes_requested",
        headCommit: "stale0000000",
        actorId: "human-stale",
        actorType: "human",
        daemonId: null,
        reason: null,
      },
    ],
    executor,
    reviewer,
    merger,
    mergeMode: "provider",
  });
  assert.equal(evaluation.satisfied, true);
  assert.deepEqual(evaluation.blockers, []);
  assert.ok(evaluation.evidence.includes("independent_reviewer"));
  assert.ok(evaluation.evidence.includes("independent_merger"));
  assert.ok(evaluation.evidence.includes("human_approvals:2"));
});

test("provider-native human approvals satisfy mixed forge and human policy evidence", () => {
  const policy = reviewPolicyInputSchema.parse({ minimumHumanApprovals: 2 });
  const evaluation = evaluateReviewPolicy(policy, {
    headCommit: "abcdef123456",
    checks: [],
    findings: [],
    decisions: [{
      kind: "forge",
      decision: "approved",
      headCommit: "abcdef123456",
      actorId: "review-daemon",
      actorType: "agent",
      daemonId: "daemon-reviewer",
      reason: null,
      metadata: {
        approvals: [
          { actorId: "alice", state: "approved", headCommit: "abcdef123456" },
          { actorId: "bob", state: "approved" },
          { actorId: "stale", state: "approved", headCommit: "oldhead12345" },
        ],
      },
    }],
    executor,
    reviewer,
  });
  assert.equal(evaluation.satisfied, true);
  assert.ok(evaluation.evidence.includes("forge_approval"));
  assert.ok(evaluation.evidence.includes("human_approvals:2"));
});

test("review evaluation fails closed for stale evidence, serious findings, and identity reuse", () => {
  const evaluation = evaluateReviewPolicy(strictPolicy, {
    headCommit: "newhead12345",
    checks: [{ name: "typecheck", status: "passed" }],
    findings: [{ severity: "critical", status: "open" }],
    decisions: [{
      kind: "ai",
      decision: "approved",
      headCommit: "oldhead12345",
      actorId: "executor",
      actorType: "agent",
      daemonId: "daemon-executor",
      reason: null,
    }],
    executor,
    reviewer: executor,
    merger: reviewer,
    mergeMode: "direct",
  });
  assert.equal(evaluation.satisfied, false);
  assert.ok(evaluation.blockers.some((blocker) => blocker.includes("'unit'")));
  assert.ok(evaluation.blockers.some((blocker) => blocker.includes("AI review")));
  assert.ok(evaluation.blockers.some((blocker) => blocker.includes("High or critical")));
  assert.ok(evaluation.blockers.some((blocker) => blocker.includes("Reviewer must be independent")));
  assert.ok(evaluation.blockers.some((blocker) => blocker.includes("not allowed")));
});

test("manual override is explicit, human-auditable evidence and never an implicit bypass", () => {
  const missingReason = evaluateReviewPolicy(strictPolicy, {
    headCommit: "abcdef123456",
    checks: [],
    findings: [],
    decisions: [{
      kind: "override",
      decision: "bypassed",
      headCommit: "abcdef123456",
      actorId: "operator",
      actorType: "human",
      daemonId: null,
      reason: null,
    }],
    executor,
    reviewer,
  });
  assert.equal(missingReason.satisfied, false);
  assert.ok(missingReason.blockers.includes("Manual override requires an audit reason"));

  const approved = evaluateReviewPolicy(strictPolicy, {
    headCommit: "abcdef123456",
    checks: [],
    findings: [],
    decisions: [{
      kind: "override",
      decision: "bypassed",
      headCommit: "abcdef123456",
      actorId: "operator",
      actorType: "human",
      daemonId: null,
      reason: "Emergency rollback approved under incident INC-42",
    }],
    executor,
    reviewer,
  });
  assert.deepEqual(approved, {
    satisfied: true,
    evidence: ["manual_override"],
    blockers: [],
    overridden: true,
  });
});

test("delivery identity enforcement blocks reviewer and merger impersonation", () => {
  assert.throws(
    () => assertIndependentDeliveryIdentity(strictPolicy, "review", {
      executor,
      reviewer: { actorId: null, actorType: null, daemonId: null },
      current: executor,
    }),
    /Reviewer must be independent/,
  );
  assert.throws(
    () => assertIndependentDeliveryIdentity(strictPolicy, "merge", {
      executor,
      reviewer,
      current: reviewer,
    }),
    /Merger must be independent/,
  );
  assert.doesNotThrow(() => assertIndependentDeliveryIdentity(strictPolicy, "merge", {
    executor,
    reviewer,
    current: merger,
  }));
  assert.doesNotThrow(() => assertIndependentDeliveryIdentity(strictPolicy, "review", {
    executor,
    reviewer: { actorId: null, actorType: null, daemonId: null },
    current: executor,
  }, { allowed: true, reason: "Audited emergency override" }));
});
