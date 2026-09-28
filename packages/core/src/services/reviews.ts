import { and, desc, eq, isNull } from "drizzle-orm";
import {
  type Database,
  activityLog,
  projects,
  requirements,
  requirementRepositories,
  reviewChecks,
  reviewDecisions,
  reviewFindings,
  reviewPolicies,
  reviewRuns,
  taskComments,
  tasks,
} from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import type { Actor, RequirementLeaseFence } from "../schemas/common";
import type {
  CreateReviewRunInput,
  EvaluateReviewRunInput,
  RecordReviewDecisionInput,
  ReviewMergeMode,
  ReviewPolicyInput,
  UpsertReviewCheckInput,
  UpsertReviewFindingInput,
} from "../schemas/reviews";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertRequirementLease } from "./claims";

export const DEFAULT_REVIEW_POLICY: ReviewPolicyInput = {
  requiredChecks: [],
  requireAiReview: false,
  minimumHumanApprovals: 0,
  requireIndependentReviewer: false,
  requireIndependentMerger: false,
  allowedMergeModes: ["provider", "direct", "manual"],
  defaultMergeMode: "direct",
  baseBranch: "main",
  retryPolicy: {
    maxAttempts: 3,
    initialBackoffSeconds: 30,
    maxBackoffSeconds: 900,
  },
  allowManualOverride: false,
  overrideRequiresReason: true,
};

type ReviewPolicyRow = typeof reviewPolicies.$inferSelect;

export interface ResolvedReviewPolicy extends ReviewPolicyInput {
  source: "built_in" | "project" | "requirement";
  id: string | null;
  projectId: string;
  requirementId: string | null;
}

export interface ReviewIdentity {
  actorId: string | null;
  actorType: "human" | "agent" | null;
  daemonId: string | null;
}

export interface ReviewPolicyEvaluation {
  satisfied: boolean;
  evidence: string[];
  blockers: string[];
  overridden: boolean;
}

interface ReviewEvaluationInput {
  headCommit: string;
  checks: Array<{ name: string; status: string }>;
  findings: Array<{ severity: string; status: string }>;
  decisions: Array<{
    kind: string;
    decision: string;
    headCommit: string;
    actorId: string;
    actorType: string;
    daemonId: string | null;
    reason: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  executor: ReviewIdentity;
  reviewer: ReviewIdentity;
  merger?: ReviewIdentity;
  mergeMode?: ReviewMergeMode;
}

function policyFields(row: ReviewPolicyRow): ReviewPolicyInput {
  return {
    requiredChecks: row.requiredChecks,
    requireAiReview: row.requireAiReview,
    minimumHumanApprovals: row.minimumHumanApprovals,
    requireIndependentReviewer: row.requireIndependentReviewer,
    requireIndependentMerger: row.requireIndependentMerger,
    allowedMergeModes: row.allowedMergeModes,
    defaultMergeMode: row.defaultMergeMode,
    baseBranch: row.baseBranch,
    retryPolicy: row.retryPolicy,
    allowManualOverride: row.allowManualOverride,
    overrideRequiresReason: row.overrideRequiresReason,
  };
}

export function resolveReviewPolicy(
  projectId: string,
  projectPolicy?: ReviewPolicyRow | null,
  requirementPolicy?: ReviewPolicyRow | null,
): ResolvedReviewPolicy {
  const selected = requirementPolicy ?? projectPolicy;
  return {
    ...(selected ? policyFields(selected) : DEFAULT_REVIEW_POLICY),
    source: requirementPolicy ? "requirement" : projectPolicy ? "project" : "built_in",
    id: selected?.id ?? null,
    projectId,
    requirementId: requirementPolicy?.requirementId ?? null,
  };
}

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity) {
  if (left.daemonId && right.daemonId && left.daemonId === right.daemonId) return true;
  return Boolean(
    left.actorId
    && right.actorId
    && left.actorType
    && right.actorType
    && left.actorId === right.actorId
    && left.actorType === right.actorType,
  );
}

function identityPresent(identity: ReviewIdentity) {
  return Boolean(identity.daemonId || (identity.actorId && identity.actorType));
}

export function evaluateReviewPolicy(
  policy: ReviewPolicyInput,
  input: ReviewEvaluationInput,
): ReviewPolicyEvaluation {
  const blockers: string[] = [];
  const evidence: string[] = [];
  const currentDecisions = input.decisions.filter((decision) => decision.headCommit === input.headCommit);
  const override = currentDecisions.find((decision) =>
    decision.kind === "override"
    && (decision.decision === "approved" || decision.decision === "bypassed"),
  );

  if (override && policy.allowManualOverride) {
    if (policy.overrideRequiresReason && !override.reason) {
      blockers.push("Manual override requires an audit reason");
    } else {
      return { satisfied: true, evidence: ["manual_override"], blockers: [], overridden: true };
    }
  }

  for (const requiredCheck of policy.requiredChecks) {
    if (!input.checks.some((check) => check.name === requiredCheck && check.status === "passed")) {
      blockers.push(`Required check '${requiredCheck}' has not passed`);
    } else {
      evidence.push(`check:${requiredCheck}`);
    }
  }

  const approvals = currentDecisions.filter((decision) => decision.decision === "approved");
  if (approvals.some((decision) => decision.kind === "forge")) {
    evidence.push("forge_approval");
  }
  if (policy.requireAiReview) {
    if (!approvals.some((decision) => decision.kind === "ai")) {
      blockers.push("AI review approval is required for the current commit");
    } else {
      evidence.push("ai_review");
    }
  }

  const humanApprovers = new Set(
    approvals
      .filter((decision) => decision.kind === "human" && decision.actorType === "human")
      .map((decision) => decision.actorId),
  );
  for (const decision of approvals.filter((candidate) => candidate.kind === "forge")) {
    const externalApprovals = Array.isArray(decision.metadata?.approvals)
      ? decision.metadata.approvals
      : [];
    for (const candidate of externalApprovals) {
      if (!candidate || typeof candidate !== "object") continue;
      const approval = candidate as Record<string, unknown>;
      if (approval.state !== "approved") continue;
      if (approval.headCommit && approval.headCommit !== input.headCommit) continue;
      if (typeof approval.actorId === "string" && approval.actorId && approval.actorId !== "unknown") {
        humanApprovers.add(`${decision.kind}:${approval.actorId}`);
      }
    }
  }
  if (humanApprovers.size < policy.minimumHumanApprovals) {
    blockers.push(
      `Requires ${policy.minimumHumanApprovals} human approval(s); found ${humanApprovers.size}`,
    );
  } else if (policy.minimumHumanApprovals > 0) {
    evidence.push(`human_approvals:${humanApprovers.size}`);
  }

  if (currentDecisions.some((decision) => decision.decision === "changes_requested")) {
    blockers.push("A current review decision requests changes");
  }
  if (input.findings.some((finding) =>
    finding.status === "open" && (finding.severity === "high" || finding.severity === "critical"),
  )) {
    blockers.push("High or critical review findings remain open");
  }

  if (policy.requireIndependentReviewer) {
    if (!identityPresent(input.executor)) {
      blockers.push("Executor identity is unavailable for separation-of-duty validation");
    } else if (!identityPresent(input.reviewer)) {
      blockers.push("Reviewer identity is unavailable for separation-of-duty validation");
    } else if (sameIdentity(input.executor, input.reviewer)) {
      blockers.push("Reviewer must be independent from the executor");
    } else {
      evidence.push("independent_reviewer");
    }
  }

  if (input.mergeMode && !policy.allowedMergeModes.includes(input.mergeMode)) {
    blockers.push(`Merge mode '${input.mergeMode}' is not allowed by policy`);
  } else if (input.mergeMode) {
    evidence.push(`merge_mode:${input.mergeMode}`);
  }

  if (policy.requireIndependentMerger && input.merger) {
    if (!identityPresent(input.merger)) {
      blockers.push("Merger identity is unavailable for separation-of-duty validation");
    } else if (sameIdentity(input.executor, input.merger) || sameIdentity(input.reviewer, input.merger)) {
      blockers.push("Merger must be independent from the executor and reviewer");
    } else {
      evidence.push("independent_merger");
    }
  }

  return { satisfied: blockers.length === 0, evidence, blockers, overridden: false };
}

export async function getEffectiveReviewPolicy(db: Database, requirementId: string) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  const [projectPolicy, requirementPolicy] = await Promise.all([
    db.query.reviewPolicies.findFirst({
      where: and(eq(reviewPolicies.projectId, requirement.projectId), isNull(reviewPolicies.requirementId)),
    }),
    db.query.reviewPolicies.findFirst({
      where: eq(reviewPolicies.requirementId, requirement.id),
    }),
  ]);
  return resolveReviewPolicy(requirement.projectId, projectPolicy, requirementPolicy);
}

export async function getProjectReviewPolicy(db: Database, projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError("Project not found");
  const policy = await db.query.reviewPolicies.findFirst({
    where: and(eq(reviewPolicies.projectId, projectId), isNull(reviewPolicies.requirementId)),
  });
  return resolveReviewPolicy(projectId, policy, null);
}

async function writePolicy(
  db: Database,
  scope: { projectId: string; requirementId: string | null },
  input: ReviewPolicyInput,
  actor: Actor,
) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, scope.projectId) });
  if (!project) throw new NotFoundError("Project not found");
  if (scope.requirementId) {
    const requirement = await db.query.requirements.findFirst({
      where: eq(requirements.id, scope.requirementId),
    });
    if (!requirement || requirement.projectId !== scope.projectId) {
      throw new ValidationError("Review policy requirement must belong to the selected project");
    }
  }
  const existing = scope.requirementId
    ? await db.query.reviewPolicies.findFirst({ where: eq(reviewPolicies.requirementId, scope.requirementId) })
    : await db.query.reviewPolicies.findFirst({
        where: and(eq(reviewPolicies.projectId, scope.projectId), isNull(reviewPolicies.requirementId)),
      });
  const values = {
    ...input,
    projectId: scope.projectId,
    requirementId: scope.requirementId,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  const [policy] = existing
    ? await db.update(reviewPolicies).set(values).where(eq(reviewPolicies.id, existing.id)).returning()
    : await db.insert(reviewPolicies).values({ ...values, createdBy: actor.id }).returning();
  const entityType = scope.requirementId ? "requirement" : "project";
  const entityId = scope.requirementId ?? scope.projectId;
  await db.insert(activityLog).values({
    entityType,
    entityId,
    action: "review_policy_updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { policyId: policy!.id, source: scope.requirementId ? "requirement" : "project", policy: input },
  });
  if (scope.requirementId) {
    emit({ type: "requirement_updated", projectId: scope.projectId, requirementId: scope.requirementId });
  }
  return policy!;
}

export async function upsertProjectReviewPolicy(
  db: Database,
  projectId: string,
  input: ReviewPolicyInput,
  actor: Actor,
) {
  return writePolicy(db, { projectId, requirementId: null }, input, actor);
}

export async function upsertRequirementReviewPolicy(
  db: Database,
  requirementId: string,
  input: ReviewPolicyInput,
  actor: Actor,
) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return writePolicy(db, { projectId: requirement.projectId, requirementId }, input, actor);
}

async function reviewRunOrThrow(db: Database, id: string) {
  const run = await db.query.reviewRuns.findFirst({
    where: eq(reviewRuns.id, id),
    with: { checks: true, findings: true, decisions: true },
  });
  if (!run) throw new NotFoundError("Review run not found");
  return run;
}

export async function getReviewRun(db: Database, id: string) {
  return reviewRunOrThrow(db, id);
}

async function assertReviewMutation(
  db: Database,
  requirementId: string,
  actor: Actor,
  fence: RequirementLeaseFence,
) {
  await assertRequirementLease(
    db,
    requirementId,
    actor,
    fence,
    fence.daemonId !== undefined || fence.leaseGeneration !== undefined,
  );
}

export async function startReviewRun(
  db: Database,
  requirementId: string,
  input: CreateReviewRunInput,
  actor: Actor,
) {
  await assertReviewMutation(db, requirementId, actor, input);
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, input.requirementRepositoryId),
  });
  if (!link || link.requirementId !== requirementId) {
    throw new ValidationError("Repository delivery does not belong to the requirement");
  }
  const existing = await db.query.reviewRuns.findFirst({
    where: eq(reviewRuns.requirementRepositoryId, link.id),
    orderBy: desc(reviewRuns.attempt),
  });
  if (
    existing
    && existing.headCommit === input.headCommit
    && (existing.status === "running" || existing.status === "approved")
    && existing.reviewerActorId === actor.id
    && existing.reviewerDaemonId === (input.daemonId ?? null)
  ) {
    return existing;
  }
  const executorActorId = input.executorActorId ?? link.executorActorId;
  const executorActorType = input.executorActorType ?? link.executorActorType;
  const executorDaemonId = input.executorDaemonId ?? link.executorDaemonId;
  const [inserted] = await db.insert(reviewRuns).values({
    requirementId,
    requirementRepositoryId: link.id,
    attempt: (existing?.attempt ?? 0) + 1,
    headCommit: input.headCommit,
    baseCommit: input.baseCommit,
    executorActorId,
    executorActorType,
    executorDaemonId,
    reviewerActorId: actor.id,
    reviewerActorType: actor.type,
    reviewerDaemonId: input.daemonId,
    supersedesRunId: existing?.id,
  }).onConflictDoNothing().returning();
  const created = inserted ?? await db.query.reviewRuns.findFirst({
    where: eq(reviewRuns.requirementRepositoryId, link.id),
    orderBy: desc(reviewRuns.attempt),
  });
  if (!created || created.headCommit !== input.headCommit) {
    throw new ConflictError("A concurrent review attempt changed the repository head", 0);
  }
  if (existing && existing.status !== "superseded") {
    await db.update(reviewRuns).set({
      status: "superseded",
      supersededByRunId: created.id,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(reviewRuns.id, existing.id));
  }
  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "review_run_started",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      reviewRunId: created.id,
      repositoryId: link.repositoryId,
      headCommit: input.headCommit,
      baseCommit: input.baseCommit,
      attempt: created.attempt,
      daemonId: input.daemonId,
      supersedesRunId: existing?.id ?? null,
    },
  });
  return created;
}

export async function upsertReviewCheck(
  db: Database,
  reviewRunId: string,
  input: UpsertReviewCheckInput,
  actor: Actor,
) {
  const run = await reviewRunOrThrow(db, reviewRunId);
  await assertReviewMutation(db, run.requirementId, actor, input);
  if (run.status !== "running") throw new ConflictError(`Review run is '${run.status}'`, 0);
  const terminal = input.status === "passed" || input.status === "failed" || input.status === "skipped";
  const [check] = await db.insert(reviewChecks).values({
    reviewRunId,
    name: input.name,
    provider: input.provider,
    status: input.status,
    externalUrl: input.externalUrl,
    summary: input.summary,
    details: input.details,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? (terminal ? new Date() : undefined),
  }).onConflictDoUpdate({
    target: [reviewChecks.reviewRunId, reviewChecks.name, reviewChecks.provider],
    set: {
      status: input.status,
      externalUrl: input.externalUrl,
      summary: input.summary,
      details: input.details,
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? (terminal ? new Date() : undefined),
      updatedAt: new Date(),
    },
  }).returning();
  return check!;
}

export async function upsertReviewFinding(
  db: Database,
  reviewRunId: string,
  input: UpsertReviewFindingInput,
  actor: Actor,
) {
  const run = await reviewRunOrThrow(db, reviewRunId);
  await assertReviewMutation(db, run.requirementId, actor, input);
  if (run.status !== "running") throw new ConflictError(`Review run is '${run.status}'`, 0);
  const [finding] = await db.insert(reviewFindings).values({
    reviewRunId,
    fingerprint: input.fingerprint,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    path: input.path,
    line: input.line,
    status: input.status,
  }).onConflictDoUpdate({
    target: [reviewFindings.reviewRunId, reviewFindings.fingerprint],
    set: {
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      path: input.path,
      line: input.line,
      status: input.status,
      updatedAt: new Date(),
    },
  }).returning();
  return finding!;
}

export async function recordReviewDecision(
  db: Database,
  reviewRunId: string,
  input: RecordReviewDecisionInput,
  actor: Actor,
) {
  const run = await reviewRunOrThrow(db, reviewRunId);
  await assertReviewMutation(db, run.requirementId, actor, input);
  if (run.status !== "running") throw new ConflictError(`Review run is '${run.status}'`, 0);
  if (input.headCommit !== run.headCommit) {
    throw new ConflictError("Review decision targets a stale commit", 0);
  }
  if (input.kind === "human" && actor.type !== "human") {
    throw new ValidationError("Human review decisions require a human actor");
  }
  if (input.kind === "override") {
    const policy = await getEffectiveReviewPolicy(db, run.requirementId);
    if (actor.type !== "human") throw new ValidationError("Manual overrides require a human actor");
    if (!policy.allowManualOverride) throw new ValidationError("Manual override is disabled by review policy");
    if (policy.overrideRequiresReason && !input.reason) {
      throw new ValidationError("Manual override requires an audit reason");
    }
  }
  const [decision] = await db.insert(reviewDecisions).values({
    reviewRunId,
    kind: input.kind,
    decision: input.decision,
    headCommit: input.headCommit,
    actorId: actor.id,
    actorType: actor.type,
    daemonId: input.daemonId,
    summary: input.summary,
    reason: input.reason,
    metadata: input.metadata,
  }).returning();
  return decision!;
}

export async function evaluateReviewRun(
  db: Database,
  reviewRunId: string,
  input: EvaluateReviewRunInput,
  actor: Actor,
) {
  const run = await reviewRunOrThrow(db, reviewRunId);
  await assertReviewMutation(db, run.requirementId, actor, input);
  if (run.status !== "running") {
    return { run, evaluation: null, policy: await getEffectiveReviewPolicy(db, run.requirementId) };
  }
  const policy = await getEffectiveReviewPolicy(db, run.requirementId);
  const evaluation = evaluateReviewPolicy(policy, {
    headCommit: run.headCommit,
    checks: run.checks,
    findings: run.findings,
    decisions: run.decisions,
    executor: {
      actorId: run.executorActorId,
      actorType: run.executorActorType,
      daemonId: run.executorDaemonId,
    },
    reviewer: {
      actorId: run.reviewerActorId,
      actorType: run.reviewerActorType,
      daemonId: run.reviewerDaemonId,
    },
    ...(input.mergerActorId || input.mergerDaemonId ? {
      merger: {
        actorId: input.mergerActorId ?? null,
        actorType: input.mergerActorType ?? null,
        daemonId: input.mergerDaemonId ?? null,
      },
    } : {}),
    mergeMode: input.mergeMode,
  });
  const changesRequested = run.decisions.some((decision) =>
    decision.headCommit === run.headCommit && decision.decision === "changes_requested",
  );
  const status = evaluation.satisfied
    ? "approved" as const
    : changesRequested
      ? "changes_requested" as const
      : "blocked" as const;
  const summary = evaluation.satisfied
    ? `Review policy satisfied by ${evaluation.evidence.join(", ") || "no mandatory evidence"}.`
    : `Review policy blocked: ${evaluation.blockers.join("; ")}.`;
  const [updated] = await db.update(reviewRuns).set({
    status,
    summary,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(reviewRuns.id, run.id)).returning();
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.requirementId, run.requirementId),
    orderBy: (row, { asc }) => [asc(row.createdAt)],
  });
  if (task) {
    await db.insert(taskComments).values({
      taskId: task.id,
      content: `Structured review run ${run.id}: ${summary}`,
      authorId: actor.id,
      authorType: actor.type,
    });
  }
  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: run.requirementId,
    action: "review_run_evaluated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      reviewRunId: run.id,
      repositoryId: run.requirementRepositoryId,
      headCommit: run.headCommit,
      status,
      evidence: evaluation.evidence,
      blockers: evaluation.blockers,
      overridden: evaluation.overridden,
      mergeMode: input.mergeMode,
      mergerDaemonId: input.mergerDaemonId,
    },
  });
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, run.requirementId),
  });
  if (requirement) {
    emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId: requirement.id });
  }
  return { run: updated!, evaluation, policy };
}

export async function listRequirementReviewRuns(
  db: Database,
  requirementId: string,
  input: { limit: number; offset: number },
) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return db.query.reviewRuns.findMany({
    where: eq(reviewRuns.requirementId, requirementId),
    with: { checks: true, findings: true, decisions: true, requirementRepository: true },
    orderBy: desc(reviewRuns.createdAt),
    limit: input.limit,
    offset: input.offset,
  });
}

export function assertIndependentDeliveryIdentity(
  policy: ReviewPolicyInput,
  phase: "review" | "merge",
  identities: { executor: ReviewIdentity; reviewer: ReviewIdentity; current: ReviewIdentity },
  override?: { allowed: boolean; reason?: string | null },
) {
  const required = phase === "review" ? policy.requireIndependentReviewer : policy.requireIndependentMerger;
  if (!required) return;
  if (override?.allowed && (!policy.overrideRequiresReason || override.reason)) return;
  if (!identityPresent(identities.executor)) {
    throw new ValidationError("Executor identity is required by separation-of-duty policy");
  }
  const conflicts = phase === "review"
    ? sameIdentity(identities.executor, identities.current)
    : sameIdentity(identities.executor, identities.current)
      || (identityPresent(identities.reviewer) && sameIdentity(identities.reviewer, identities.current));
  if (conflicts) {
    throw new ValidationError(
      phase === "review"
        ? "Reviewer must be independent from the executor"
        : "Merger must be independent from the executor and reviewer",
    );
  }
}
