import { and, eq, lte, not } from "drizzle-orm";
import {
  type Database,
  activityLog,
  schedules,
  scheduleRuns,
} from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import type { Actor } from "../schemas/common";
import type {
  AcquireDueSchedulesInput,
  CreateScheduleInput,
  ListSchedulesInput,
  UpdateScheduleInput,
} from "../schemas/schedules";
import { NotFoundError, ValidationError } from "../errors";
import { createTask } from "./tasks";
import { createRun } from "./pi-agent";

type ScheduleRow = typeof schedules.$inferSelect;

function toScheduleValues(input: CreateScheduleInput, actor: Actor) {
  return {
    projectId: input.projectId,
    requirementId: input.requirementId,
    targetScope: input.targetScope,
    kind: input.kind,
    title: input.title,
    description: input.description,
    timezone: input.timezone,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    nextRunAt: input.nextRunAt ?? input.startsAt,
    recurrenceSyntax: input.recurrenceSyntax,
    recurrenceRule: input.recurrenceRule,
    catchUpPolicy: input.catchUpPolicy,
    expiryWindowMinutes: input.expiryWindowMinutes,
    maxCatchUpRuns: input.maxCatchUpRuns,
    taskTitle: input.taskTemplate.title,
    taskDescription: input.taskTemplate.description,
    taskPriority: input.taskTemplate.priority,
    autoRun: input.autoRun,
    assignedExecutor: input.assignedExecutor,
    assignedExecutorType: input.assignedExecutorType,
    requestedPiProvider: input.requestedPiProvider,
    requestedPiModel: input.requestedPiModel,
    createdBy: actor.id,
  };
}

function toScheduleUpdateValues(input: UpdateScheduleInput) {
  return {
    projectId: input.projectId,
    requirementId: input.requirementId,
    targetScope: input.targetScope,
    kind: input.kind,
    title: input.title,
    description: input.description,
    status: input.status,
    timezone: input.timezone,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    nextRunAt: input.nextRunAt,
    recurrenceSyntax: input.recurrenceSyntax,
    recurrenceRule: input.recurrenceRule,
    catchUpPolicy: input.catchUpPolicy,
    expiryWindowMinutes: input.expiryWindowMinutes,
    maxCatchUpRuns: input.maxCatchUpRuns,
    taskTitle: input.taskTemplate?.title,
    taskDescription: input.taskTemplate?.description,
    taskPriority: input.taskTemplate?.priority,
    autoRun: input.autoRun,
    assignedExecutor: input.assignedExecutor,
    assignedExecutorType: input.assignedExecutorType,
    requestedPiProvider: input.requestedPiProvider,
    requestedPiModel: input.requestedPiModel,
    updatedAt: new Date(),
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as Partial<T>;
}

export async function createSchedule(
  db: Database,
  input: CreateScheduleInput,
  actor: Actor,
) {
  const [schedule] = await db
    .insert(schedules)
    .values(toScheduleValues(input, actor))
    .returning();

  await db.insert(activityLog).values({
    entityType: "schedule",
    entityId: schedule!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { title: schedule!.title, kind: schedule!.kind },
  });

  emit({ type: "schedule_created", projectId: schedule!.projectId, scheduleId: schedule!.id });
  return schedule!;
}

export async function listSchedules(db: Database, input: ListSchedulesInput) {
  const conditions = [];
  if (input.projectId) conditions.push(eq(schedules.projectId, input.projectId));
  if (input.status) conditions.push(eq(schedules.status, input.status));
  if (input.targetScope) conditions.push(eq(schedules.targetScope, input.targetScope));
  if (!input.includeArchived) conditions.push(not(eq(schedules.status, "archived")));

  return db.query.schedules.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    with: {
      runs: {
        orderBy: (run, { desc }) => [desc(run.plannedFor)],
        limit: 5,
      },
    },
    orderBy: (schedule, { asc }) => [asc(schedule.nextRunAt), asc(schedule.createdAt)],
  });
}

export async function getSchedule(db: Database, id: string) {
  const schedule = await db.query.schedules.findFirst({
    where: eq(schedules.id, id),
    with: {
      runs: {
        with: { generatedTask: true },
        orderBy: (run, { desc }) => [desc(run.plannedFor)],
      },
    },
  });
  if (!schedule) throw new NotFoundError("Schedule not found");
  return schedule;
}

export async function updateSchedule(
  db: Database,
  id: string,
  input: UpdateScheduleInput,
  actor: Actor,
) {
  await getSchedule(db, id);
  const [updated] = await db
    .update(schedules)
    .set(stripUndefined(toScheduleUpdateValues(input)))
    .where(eq(schedules.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "schedule",
    entityId: id,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { changes: input },
  });

  emit({ type: "schedule_updated", projectId: updated!.projectId, scheduleId: id });
  return updated!;
}

export async function archiveSchedule(db: Database, id: string, actor: Actor) {
  const [updated] = await db
    .update(schedules)
    .set({ status: "archived", nextRunAt: null, updatedAt: new Date() })
    .where(eq(schedules.id, id))
    .returning();
  if (!updated) throw new NotFoundError("Schedule not found");

  await db.insert(activityLog).values({
    entityType: "schedule",
    entityId: id,
    action: "archived",
    actorId: actor.id,
    actorType: actor.type,
  });

  emit({ type: "schedule_updated", projectId: updated.projectId, scheduleId: id });
  return updated;
}

export async function listScheduleRuns(db: Database, scheduleId: string) {
  await getSchedule(db, scheduleId);
  return db.query.scheduleRuns.findMany({
    where: eq(scheduleRuns.scheduleId, scheduleId),
    with: { generatedTask: true },
    orderBy: (run, { desc }) => [desc(run.plannedFor)],
  });
}

export async function runScheduleNow(db: Database, id: string, actor: Actor) {
  const schedule = await getSchedule(db, id);
  if (schedule.status === "archived") {
    throw new ValidationError("Archived schedules cannot be run");
  }
  return processOccurrence(db, schedule, new Date(), actor, "manual");
}

export async function acquireDueSchedules(
  db: Database,
  input: AcquireDueSchedulesInput,
  actor: Actor,
) {
  const now = input.now ?? new Date();
  const conditions = [
    eq(schedules.status, "active"),
    lte(schedules.nextRunAt, now),
  ];
  if (input.projectId) conditions.push(eq(schedules.projectId, input.projectId));

  const dueSchedules = await db.query.schedules.findMany({
    where: and(...conditions),
    orderBy: (schedule, { asc }) => [asc(schedule.nextRunAt), asc(schedule.createdAt)],
    limit: input.limit,
  });

  const results = [];
  for (const schedule of dueSchedules) {
    results.push(await processDueSchedule(db, schedule, now, actor));
  }
  return results;
}

async function processDueSchedule(
  db: Database,
  schedule: ScheduleRow,
  now: Date,
  actor: Actor,
) {
  const plan = planDueOccurrences(schedule, now);
  const created = [];
  const skipped = [];

  for (const occurrence of plan.skip) {
    skipped.push(await recordSkippedRun(db, schedule, occurrence, "Missed occurrence skipped by catch-up or expiry policy"));
  }
  for (const occurrence of plan.create) {
    created.push(await processOccurrence(db, schedule, occurrence, actor, "scheduled"));
  }

  await db
    .update(schedules)
    .set({ nextRunAt: plan.nextRunAt, updatedAt: new Date() })
    .where(eq(schedules.id, schedule.id));

  return { scheduleId: schedule.id, created, skipped, nextRunAt: plan.nextRunAt };
}

async function processOccurrence(
  db: Database,
  schedule: ScheduleRow,
  plannedFor: Date,
  actor: Actor,
  mode: "manual" | "scheduled",
) {
  const run = await ensurePendingRun(db, schedule, plannedFor);
  if (run.status === "created" && run.generatedTaskId) return run;

  if (schedule.targetScope === "project" && (!schedule.projectId || !schedule.requirementId)) {
    return markRunSkipped(db, run.id, "Project schedules require a project and requirement to generate tasks");
  }

  const taskInput = schedule.targetScope === "personal"
    ? {
      scope: "personal" as const,
      status: "todo" as const,
      title: schedule.taskTitle,
      description: schedule.taskDescription ?? `Generated from schedule: ${schedule.title}`,
      priority: schedule.taskPriority,
      assignee: schedule.assignedExecutor ?? undefined,
      assigneeType: schedule.assignedExecutorType ?? undefined,
      requestedPiProvider: schedule.requestedPiProvider ?? undefined,
      requestedPiModel: schedule.requestedPiModel ?? undefined,
      personalOwnerId: schedule.assignedExecutor ?? schedule.createdBy,
      personalOwnerType: schedule.assignedExecutorType ?? "human" as const,
      tags: ["generated:schedule", `schedule:${schedule.id}`, mode === "manual" ? "schedule:manual" : "schedule:auto"],
      expectedAt: plannedFor,
    }
    : {
      scope: "project" as const,
      projectId: schedule.projectId!,
      requirementId: schedule.requirementId!,
      status: "todo" as const,
      title: schedule.taskTitle,
      description: schedule.taskDescription ?? `Generated from schedule: ${schedule.title}`,
      priority: schedule.taskPriority,
      assignee: schedule.assignedExecutor ?? undefined,
      assigneeType: schedule.assignedExecutorType ?? undefined,
      requestedPiProvider: schedule.requestedPiProvider ?? undefined,
      requestedPiModel: schedule.requestedPiModel ?? undefined,
      tags: ["generated:schedule", `schedule:${schedule.id}`, mode === "manual" ? "schedule:manual" : "schedule:auto"],
      expectedAt: plannedFor,
    };

  const task = await createTask(db, taskInput, actor);

  const [updated] = await db
    .update(scheduleRuns)
    .set({
      status: "created",
      generatedTaskId: task.id,
      requestedPiProvider: schedule.requestedPiProvider,
      requestedPiModel: schedule.requestedPiModel,
      completedAt: new Date(),
    })
    .where(eq(scheduleRuns.id, run.id))
    .returning();

  emit({
    type: "schedule_run_created",
    projectId: schedule.projectId,
    scheduleId: schedule.id,
    runId: updated!.id,
    taskId: task.id,
  });

  if (schedule.autoRun && schedule.assignedExecutor && schedule.assignedExecutorType === "agent") {
    await createRun(db, {
      taskId: task.id,
      scheduleRunId: updated!.id,
      assignedAgentId: schedule.assignedExecutor,
      assignedAgentType: "agent",
      requestedPiProvider: schedule.requestedPiProvider,
      requestedPiModel: schedule.requestedPiModel,
    }, actor);
  }

  return updated!;
}

async function ensurePendingRun(db: Database, schedule: ScheduleRow, plannedFor: Date) {
  const [inserted] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId: schedule.id,
      plannedFor,
      status: "pending",
      requestedPiProvider: schedule.requestedPiProvider,
      requestedPiModel: schedule.requestedPiModel,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const existing = await db.query.scheduleRuns.findFirst({
    where: and(eq(scheduleRuns.scheduleId, schedule.id), eq(scheduleRuns.plannedFor, plannedFor)),
  });
  if (!existing) throw new ValidationError("Could not reserve schedule run");
  return existing;
}

async function recordSkippedRun(db: Database, schedule: ScheduleRow, plannedFor: Date, reason: string) {
  const run = await ensurePendingRun(db, schedule, plannedFor);
  if (run.status !== "pending") return run;
  return markRunSkipped(db, run.id, reason);
}

async function markRunSkipped(db: Database, runId: string, reason: string) {
  const [updated] = await db
    .update(scheduleRuns)
    .set({ status: "skipped", skippedReason: reason, completedAt: new Date() })
    .where(eq(scheduleRuns.id, runId))
    .returning();
  return updated!;
}

export function planDueOccurrences(schedule: ScheduleRow, now: Date) {
  const occurrences = collectDueOccurrences(schedule, now);
  const selected = selectOccurrences(schedule, occurrences, now);
  const nextRunAt = computeNextRunAt(schedule, occurrences.at(-1) ?? schedule.nextRunAt ?? schedule.startsAt);
  return { ...selected, nextRunAt };
}

function collectDueOccurrences(schedule: ScheduleRow, now: Date) {
  const occurrences: Date[] = [];
  let current = schedule.nextRunAt ?? schedule.startsAt;
  const maxIterations = schedule.kind === "one_off" ? 1 : 500;

  for (let i = 0; i < maxIterations && current <= now; i += 1) {
    if (!schedule.endsAt || current <= schedule.endsAt) occurrences.push(current);
    const next = computeNextRunAt(schedule, current);
    if (!next || next.getTime() <= current.getTime()) break;
    current = next;
  }

  return occurrences;
}

function selectOccurrences(schedule: ScheduleRow, occurrences: Date[], now: Date) {
  const expiryCutoff = schedule.expiryWindowMinutes
    ? new Date(now.getTime() - schedule.expiryWindowMinutes * 60_000)
    : null;
  const fresh = expiryCutoff
    ? occurrences.filter((occurrence) => occurrence >= expiryCutoff)
    : occurrences;
  const stale = expiryCutoff
    ? occurrences.filter((occurrence) => occurrence < expiryCutoff)
    : [];

  if (fresh.length === 0) return { create: [], skip: occurrences };

  if (schedule.catchUpPolicy === "all") {
    const max = schedule.maxCatchUpRuns ?? fresh.length;
    const create = fresh.slice(-max);
    const omittedFresh = fresh.slice(0, Math.max(0, fresh.length - max));
    return { create, skip: [...stale, ...omittedFresh] };
  }

  const latest = fresh.at(-1)!;
  return { create: [latest], skip: occurrences.filter((occurrence) => occurrence.getTime() !== latest.getTime()) };
}

export function computeNextRunAt(schedule: Pick<ScheduleRow, "kind" | "recurrenceSyntax" | "recurrenceRule" | "endsAt">, after: Date) {
  if (schedule.kind === "one_off") return null;
  if (!schedule.recurrenceRule) return null;

  const next = schedule.recurrenceSyntax === "cron"
    ? nextCronOccurrence(schedule.recurrenceRule, after)
    : nextRRuleOccurrence(schedule.recurrenceRule, after);
  if (!next) return null;
  if (schedule.endsAt && next > schedule.endsAt) return null;
  return next;
}

function nextRRuleOccurrence(rule: string, after: Date) {
  const parts = Object.fromEntries(
    rule.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key?.toUpperCase(), value?.toUpperCase()];
    }),
  );
  const interval = Math.max(1, Number(parts.INTERVAL ?? "1") || 1);
  switch (parts.FREQ) {
    case "MINUTELY":
      return new Date(after.getTime() + interval * 60_000);
    case "HOURLY":
      return new Date(after.getTime() + interval * 3_600_000);
    case "DAILY":
      return new Date(after.getTime() + interval * 86_400_000);
    case "WEEKLY":
      return new Date(after.getTime() + interval * 7 * 86_400_000);
    default:
      return null;
  }
}

function nextCronOccurrence(rule: string, after: Date) {
  const [minute, hour] = rule.trim().split(/\s+/);
  if (!minute || !hour) return null;
  if (minute.startsWith("*/") && hour === "*") {
    const interval = Math.max(1, Number(minute.slice(2)) || 1);
    return new Date(after.getTime() + interval * 60_000);
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const next = new Date(after);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(Number(hour), Number(minute), 0, 0);
    return next;
  }
  return null;
}
