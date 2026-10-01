import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  agentUsageRuns,
  projects,
  daemons,
  piAgentRuns,
  requirementClaims,
  requirements,
  tasks,
  type Database,
} from "@task-weaver/db";
import {
  NotFoundError,
  ValidationError,
  type Actor,
  type AgentUsageQuery,
  type AgentUsageSummary,
  type ReportAgentUsageInput,
  type ReportPiAgentUsageInput,
} from "@task-weaver/contracts";

export type UsageRun = typeof agentUsageRuns.$inferSelect;
type UsageWrite = typeof agentUsageRuns.$inferInsert;
const counters = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export function reconcileUsage(
  existing: UsageRun,
  incoming: UsageWrite,
): UsageWrite | null {
  const immutable = [
    "projectId",
    "requirementId",
    "taskId",
    "daemonId",
    "piRunId",
    "attempt",
    "source",
    "agent",
    "phase",
    "reportedBy",
  ] as const;
  if (
    immutable.some(
      (key) => (existing[key] ?? null) !== (incoming[key] ?? null),
    ) ||
    existing.startedAt.getTime() !== incoming.startedAt.getTime()
  ) {
    throw new ValidationError("Process identity and attribution cannot change");
  }
  if (incoming.revision < existing.revision) return null;
  if (incoming.revision === existing.revision) {
    if (
      Object.keys(existing.summary).some(
        (key) =>
          existing.summary[key as keyof AgentUsageSummary] !==
          incoming.summary[key as keyof AgentUsageSummary],
      ) ||
      existing.outcome !== incoming.outcome ||
      (existing.endedAt?.getTime() ?? null) !==
        (incoming.endedAt?.getTime() ?? null)
    ) {
      throw new ValidationError(
        "A report revision cannot be reused with different totals",
      );
    }
    return null;
  }
  if (
    existing.outcome !== "running" &&
    (incoming.outcome !== existing.outcome ||
      incoming.endedAt?.getTime() !== existing.endedAt?.getTime())
  ) {
    throw new ValidationError(
      "A terminal process cannot be restarted or change its outcome",
    );
  }
  for (const key of counters) {
    const prior = existing.summary[key];
    if (
      prior !== null &&
      (incoming.summary[key] === null || incoming.summary[key]! < prior)
    ) {
      throw new ValidationError(
        "Cumulative usage cannot decrease or discard reported counters",
      );
    }
  }
  if (
    existing.summary.cacheSemantics !== "unknown" &&
    incoming.summary.cacheSemantics !== existing.summary.cacheSemantics
  ) {
    throw new ValidationError("Reported cache semantics cannot change");
  }
  return incoming;
}

async function persist(db: Database, input: UsageWrite) {
  // Serialize insert and update, including concurrent first reports, on one process row.
  return db.transaction(async (tx) => {
    await tx.insert(agentUsageRuns).values(input).onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(agentUsageRuns)
      .where(eq(agentUsageRuns.processId, input.processId))
      .for("update");
    if (!existing) throw new NotFoundError("Usage process not found");
    const update = reconcileUsage(existing, input);
    if (!update) return existing;
    const [row] = await tx
      .update(agentUsageRuns)
      .set({
        revision: input.revision,
        summary: input.summary,
        outcome: input.outcome,
        endedAt: input.endedAt,
        updatedAt: new Date(),
      })
      .where(eq(agentUsageRuns.processId, input.processId))
      .returning();
    return row!;
  });
}

export async function validateScope(
  db: Database,
  input: { projectId: string; requirementId?: string; taskId?: string },
) {
  if (
    !(await db.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    }))
  )
    throw new NotFoundError("Project not found");
  if (input.requirementId) {
    const requirement = await db.query.requirements.findFirst({
      where: eq(requirements.id, input.requirementId),
    });
    if (!requirement || requirement.projectId !== input.projectId)
      throw new ValidationError("Requirement does not belong to this project");
  }
  if (input.taskId) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, input.taskId),
    });
    if (
      !task ||
      task.projectId !== input.projectId ||
      (input.requirementId && task.requirementId !== input.requirementId)
    )
      throw new ValidationError("Task does not belong to this scope");
  }
}

export function normalizeOutcomeSummary(
  summary: AgentUsageSummary,
  outcome: UsageWrite["outcome"],
): AgentUsageSummary {
  return {
    ...summary,
    completeness:
      outcome !== "succeeded" && summary.completeness === "complete"
        ? "partial"
        : summary.completeness,
  };
}

export async function reportDaemonUsage(
  db: Database,
  input: ReportAgentUsageInput,
  actor: Actor,
) {
  if (input.agent !== "codex" && input.summary.completeness !== "unknown")
    throw new ValidationError(
      "Unverified daemon adapters must report unknown usage",
    );
  await validateScope(db, input);
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, input.daemonId),
  });
  if (!daemon) throw new NotFoundError("Daemon not found");
  const existing = await db
    .select()
    .from(agentUsageRuns)
    .where(eq(agentUsageRuns.processId, input.processId))
    .limit(1);
  if (!existing.length) {
    const claim = await db.query.requirementClaims.findFirst({
      where: eq(requirementClaims.requirementId, input.requirementId),
    });
    if (
      !claim ||
      claim.daemonId !== input.daemonId ||
      claim.expiresAt <= new Date()
    )
      throw new ValidationError(
        "Daemon usage registration requires its active requirement lane",
      );
  } else if (existing[0]!.reportedBy !== actor.id) {
    throw new ValidationError(
      "Usage report belongs to another authenticated reporter",
    );
  }
  return persist(db, {
    ...input,
    taskId: null,
    piRunId: null,
    attempt: null,
    source: input.agent === "codex" ? "codex_jsonl" : "daemon_unknown",
    startedAt: new Date(input.startedAt),
    endedAt: input.endedAt ? new Date(input.endedAt) : null,
    summary: normalizeOutcomeSummary(input.summary, input.outcome),
    reportedBy: actor.id,
  });
}

export async function reportPiUsage(
  db: Database,
  runId: string,
  input: ReportPiAgentUsageInput,
  actor: Actor,
) {
  const run = await db.query.piAgentRuns.findFirst({
    where: eq(piAgentRuns.id, runId),
  });
  if (!run) throw new NotFoundError("Ti run not found");
  if (actor.id !== run.assignedAgentId && actor.id !== run.createdBy)
    throw new ValidationError(
      "Authenticated reporter cannot report this Ti run",
    );
  const [existing] = await db
    .select()
    .from(agentUsageRuns)
    .where(eq(agentUsageRuns.processId, input.processId))
    .limit(1);
  if (!existing) {
    if (
      run.retryCount !== input.attempt ||
      run.leaseOwnerId !== input.workerId ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= new Date() ||
      !["running", "in_review"].includes(run.status)
    )
      throw new ValidationError(
        "Ti usage registration requires the active attempt and worker lease",
      );
  } else if (
    existing.reportedBy !== actor.id ||
    existing.piRunId !== runId ||
    existing.attempt !== input.attempt
  ) {
    throw new ValidationError(
      "Ti process identity belongs to another reporter or attempt",
    );
  }
  if (!run.taskId)
    throw new ValidationError("Ti usage requires a project task target");
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, run.taskId),
  });
  if (!task?.projectId || !task.requirementId)
    throw new ValidationError("Ti usage requires a project task target");
  return persist(db, {
    processId: input.processId,
    projectId: task.projectId,
    requirementId: task.requirementId,
    taskId: task.id,
    daemonId: null,
    piRunId: run.id,
    attempt: input.attempt,
    source: "ti_runtime",
    agent: "ti",
    phase: input.attempt > 0 ? "rework" : "execution",
    revision: input.revision,
    outcome: input.outcome,
    startedAt: new Date(input.startedAt),
    endedAt: input.endedAt ? new Date(input.endedAt) : null,
    summary: normalizeOutcomeSummary(input.summary, input.outcome),
    reportedBy: actor.id,
  });
}

function filters(input: AgentUsageQuery) {
  return and(
    eq(agentUsageRuns.projectId, input.projectId),
    input.requirementId
      ? eq(agentUsageRuns.requirementId, input.requirementId)
      : undefined,
    input.taskId ? eq(agentUsageRuns.taskId, input.taskId) : undefined,
    input.since
      ? gte(agentUsageRuns.startedAt, new Date(input.since))
      : undefined,
    input.until
      ? lt(agentUsageRuns.startedAt, new Date(input.until))
      : undefined,
    input.phase ? eq(agentUsageRuns.phase, input.phase) : undefined,
    input.completeness
      ? sql`${agentUsageRuns.summary}->>'completeness' = ${input.completeness}`
      : undefined,
  );
}
export async function listUsage(db: Database, input: AgentUsageQuery) {
  await validateScope(db, input);
  const [items, total] = await Promise.all([
    db
      .select()
      .from(agentUsageRuns)
      .where(filters(input))
      .orderBy(desc(agentUsageRuns.startedAt), desc(agentUsageRuns.processId))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentUsageRuns)
      .where(filters(input)),
  ]);
  return {
    items,
    total: total[0]?.count ?? 0,
    limit: input.limit,
    offset: input.offset,
  };
}
export async function getUsage(
  db: Database,
  projectId: string,
  processId: string,
) {
  const [row] = await db
    .select()
    .from(agentUsageRuns)
    .where(
      and(
        eq(agentUsageRuns.processId, processId),
        eq(agentUsageRuns.projectId, projectId),
      ),
    );
  if (!row) throw new NotFoundError("Usage process not found in this project");
  return row;
}
export async function summarizeUsage(db: Database, input: AgentUsageQuery) {
  await validateScope(db, input);
  // Aggregate in PostgreSQL without loading all process rows or losing integer precision.
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      complete: sql<number>`count(*) filter (where ${agentUsageRuns.summary}->>'completeness' = 'complete')::int`,
      partial: sql<number>`count(*) filter (where ${agentUsageRuns.summary}->>'completeness' = 'partial')::int`,
      unknown: sql<number>`count(*) filter (where ${agentUsageRuns.summary}->>'completeness' = 'unknown')::int`,
      running: sql<number>`count(*) filter (where ${agentUsageRuns.outcome} = 'running')::int`,
      inputTokens: sql<
        string | null
      >`sum((${agentUsageRuns.summary}->>'inputTokens')::numeric)::text`,
      outputTokens: sql<
        string | null
      >`sum((${agentUsageRuns.summary}->>'outputTokens')::numeric)::text`,
      cacheReadTokens: sql<
        string | null
      >`sum((${agentUsageRuns.summary}->>'cacheReadTokens')::numeric)::text`,
      cacheWriteTokens: sql<
        string | null
      >`sum((${agentUsageRuns.summary}->>'cacheWriteTokens')::numeric)::text`,
      inputReportedRuns: sql<number>`count(${agentUsageRuns.summary}->>'inputTokens')::int`,
      outputReportedRuns: sql<number>`count(${agentUsageRuns.summary}->>'outputTokens')::int`,
      cacheReadReportedRuns: sql<number>`count(${agentUsageRuns.summary}->>'cacheReadTokens')::int`,
      cacheWriteReportedRuns: sql<number>`count(${agentUsageRuns.summary}->>'cacheWriteTokens')::int`,
    })
    .from(agentUsageRuns)
    .where(filters(input));
  const reportedAttempts = db
    .select({
      piRunId: agentUsageRuns.piRunId,
      count: sql<number>`count(distinct ${agentUsageRuns.attempt})::int`.as(
        "reported_attempt_count",
      ),
    })
    .from(agentUsageRuns)
    .where(eq(agentUsageRuns.source, "ti_runtime"))
    .groupBy(agentUsageRuns.piRunId)
    .as("reported_attempts");
  const [missing] = await db
    .select({
      count: sql<number>`coalesce(sum(greatest(${piAgentRuns.retryCount} + case when ${piAgentRuns.status} = 'queued' then 0 else 1 end - coalesce(${reportedAttempts.count}, 0), 0)), 0)::int`,
    })
    .from(piAgentRuns)
    .innerJoin(tasks, eq(piAgentRuns.taskId, tasks.id))
    .leftJoin(reportedAttempts, eq(reportedAttempts.piRunId, piAgentRuns.id))
    .where(
      and(
        eq(tasks.projectId, input.projectId),
        isNotNull(piAgentRuns.startedAt),
        input.requirementId
          ? eq(tasks.requirementId, input.requirementId)
          : undefined,
        input.taskId ? eq(tasks.id, input.taskId) : undefined,
      ),
    );
  const knownUnregisteredTiAttempts = missing?.count ?? 0;
  const denominator = (row?.runs ?? 0) + knownUnregisteredTiAttempts;
  return {
    ...row!,
    knownUnregisteredTiAttempts,
    coverage: denominator ? row!.complete / denominator : null,
    accountingSince:
      "Totals cover registered processes only. Known Ti attempts without reports reduce coverage across this project/requirement/task scope, regardless of date or phase filters because their process timestamps are unavailable. Unregistered daemon processes and earlier history cannot be counted.",
  };
}

/** Finalize a registered Ti process without discarding reports sent during execution. */
export async function finishPiUsage(
  db: Database,
  runId: string,
  processId: string,
  input: { outcome: "succeeded" | "failed" | "cancelled"; endedAt: string },
  actor: Actor,
) {
  const run = await db.query.piAgentRuns.findFirst({
    where: eq(piAgentRuns.id, runId),
  });
  if (!run) throw new NotFoundError("Ti run not found");
  if (actor.id !== run.assignedAgentId && actor.id !== run.createdBy)
    throw new ValidationError(
      "Authenticated reporter cannot finalize this Ti run",
    );
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentUsageRuns)
      .where(
        and(
          eq(agentUsageRuns.processId, processId),
          eq(agentUsageRuns.piRunId, runId),
        ),
      )
      .for("update");
    if (!existing || existing.reportedBy !== actor.id)
      throw new ValidationError("Ti usage process belongs to another reporter");
    if (existing.outcome !== "running") return existing;
    const endedAt = new Date(input.endedAt);
    if (endedAt < existing.startedAt)
      throw new ValidationError("Run end precedes start");
    const [updated] = await tx
      .update(agentUsageRuns)
      .set({
        outcome: input.outcome,
        endedAt,
        revision: existing.revision + 1,
        summary: normalizeOutcomeSummary(existing.summary, input.outcome),
        updatedAt: new Date(),
      })
      .where(eq(agentUsageRuns.processId, processId))
      .returning();
    return updated!;
  });
}
