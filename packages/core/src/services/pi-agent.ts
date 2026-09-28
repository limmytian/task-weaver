import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  type Database,
  activityLog,
  piAgentModelConfigs,
  piAgentPolicies,
  piAgentRuns,
  scheduleRuns,
  tasks,
} from "@task-weaver/db";
import type { Actor } from "../schemas/common";
import type {
  AcquirePiAgentRunInput,
  CompletePiAgentRunInput,
  CreatePiAgentRunInput,
  ListPiAgentRunsInput,
  ListPiModelConfigsInput,
  ResolvePiModelInput,
  SetDefaultPiModelInput,
  UpsertPiAgentPolicyInput,
  UpsertPiModelConfigInput,
} from "../schemas/pi-agent";
import { NotFoundError, ValidationError } from "../errors";

type PiModelConfig = typeof piAgentModelConfigs.$inferSelect;

function owner(input: { ownerId?: string; ownerType?: "human" | "agent" }, actor: Actor) {
  return {
    ownerId: input.ownerId ?? actor.id,
    ownerType: input.ownerType ?? actor.type,
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as Partial<T>;
}

async function clearDefault(
  db: Database,
  ownerId: string,
  ownerType: "human" | "agent",
  exceptConfigId?: string,
) {
  await db
    .update(piAgentModelConfigs)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(piAgentModelConfigs.ownerId, ownerId),
        eq(piAgentModelConfigs.ownerType, ownerType),
        exceptConfigId
          ? sql`${piAgentModelConfigs.id} <> ${exceptConfigId}`
          : sql`true`,
      ),
    );
}

export async function upsertModelConfig(
  db: Database,
  input: UpsertPiModelConfigInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  if (input.isDefault) {
    await clearDefault(db, targetOwner.ownerId, targetOwner.ownerType);
  }

  const [config] = await db
    .insert(piAgentModelConfigs)
    .values({
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      label: input.label,
      apiKeyRef: input.apiKeyRef,
      credentialStatus: input.credentialStatus,
      enabled: input.enabled,
      isDefault: input.isDefault,
      capabilities: input.capabilities,
      costMetadata: input.costMetadata ?? undefined,
      availabilityCheckedAt: input.availabilityCheckedAt,
    })
    .onConflictDoUpdate({
      target: [
        piAgentModelConfigs.ownerId,
        piAgentModelConfigs.ownerType,
        piAgentModelConfigs.provider,
        piAgentModelConfigs.model,
      ],
      set: stripUndefined({
        label: input.label,
        baseUrl: input.baseUrl,
        apiKeyRef: input.apiKeyRef,
        credentialStatus: input.credentialStatus,
        enabled: input.enabled,
        isDefault: input.isDefault,
        capabilities: input.capabilities,
        costMetadata: input.costMetadata ?? undefined,
        availabilityCheckedAt: input.availabilityCheckedAt,
        updatedAt: new Date(),
      }),
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "pi_agent_model_config",
    entityId: config!.id,
    action: "upserted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      isDefault: input.isDefault,
    },
  });

  return config!;
}

export async function listModelConfigs(
  db: Database,
  input: ListPiModelConfigsInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const conditions = [
    eq(piAgentModelConfigs.ownerId, targetOwner.ownerId),
    eq(piAgentModelConfigs.ownerType, targetOwner.ownerType),
  ];
  if (!input.includeDisabled) conditions.push(eq(piAgentModelConfigs.enabled, true));

  return db.query.piAgentModelConfigs.findMany({
    where: and(...conditions),
    orderBy: (config, { desc, asc }) => [desc(config.isDefault), asc(config.provider), asc(config.model)],
  });
}

export async function setDefaultModel(
  db: Database,
  input: SetDefaultPiModelInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const config = await db.query.piAgentModelConfigs.findFirst({
    where: and(
      eq(piAgentModelConfigs.id, input.configId),
      eq(piAgentModelConfigs.ownerId, targetOwner.ownerId),
      eq(piAgentModelConfigs.ownerType, targetOwner.ownerType),
    ),
  });
  if (!config) throw new NotFoundError("Ti model config not found");
  if (!config.enabled) throw new ValidationError("Disabled Ti model configs cannot be default");

  await clearDefault(db, targetOwner.ownerId, targetOwner.ownerType, config.id);
  const [updated] = await db
    .update(piAgentModelConfigs)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(piAgentModelConfigs.id, config.id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "pi_agent_model_config",
    entityId: config.id,
    action: "default_set",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { provider: config.provider, model: config.model },
  });

  return updated!;
}

export async function upsertPolicy(
  db: Database,
  input: UpsertPiAgentPolicyInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const [policy] = await db
    .insert(piAgentPolicies)
    .values({
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      enabled: input.enabled,
      executionMode: input.executionMode,
      maxConcurrentRuns: input.maxConcurrentRuns,
      dailyRunLimit: input.dailyRunLimit,
      monthlyRunLimit: input.monthlyRunLimit,
      runTimeoutSeconds: input.runTimeoutSeconds,
      defaultMaxRetries: input.defaultMaxRetries,
      toolAllowlist: input.toolAllowlist,
      toolDenylist: input.toolDenylist,
      assistantAutoEnabled: input.assistantAutoEnabled,
      assistantAutoMode: input.assistantAutoMode,
      assistantActionAllowlist: input.assistantActionAllowlist,
      assistantDailyActionLimit: input.assistantDailyActionLimit,
      assistantRunTimeoutSeconds: input.assistantRunTimeoutSeconds,
      assistantDefaultMaxRetries: input.assistantDefaultMaxRetries,
      assistantUncertainToReview: input.assistantUncertainToReview,
    })
    .onConflictDoUpdate({
      target: [piAgentPolicies.ownerId, piAgentPolicies.ownerType],
      set: stripUndefined({
        enabled: input.enabled,
        executionMode: input.executionMode,
        maxConcurrentRuns: input.maxConcurrentRuns,
        dailyRunLimit: input.dailyRunLimit,
        monthlyRunLimit: input.monthlyRunLimit,
        runTimeoutSeconds: input.runTimeoutSeconds,
        defaultMaxRetries: input.defaultMaxRetries,
        toolAllowlist: input.toolAllowlist,
        toolDenylist: input.toolDenylist,
        assistantAutoEnabled: input.assistantAutoEnabled,
        assistantAutoMode: input.assistantAutoMode,
        assistantActionAllowlist: input.assistantActionAllowlist,
        assistantDailyActionLimit: input.assistantDailyActionLimit,
        assistantRunTimeoutSeconds: input.assistantRunTimeoutSeconds,
        assistantDefaultMaxRetries: input.assistantDefaultMaxRetries,
        assistantUncertainToReview: input.assistantUncertainToReview,
        updatedAt: new Date(),
      }),
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "pi_agent_policy",
    entityId: policy!.id,
    action: "upserted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      enabled: input.enabled,
      executionMode: input.executionMode,
      assistantAutoEnabled: input.assistantAutoEnabled,
      assistantAutoMode: input.assistantAutoMode,
    },
  });

  return policy!;
}

export async function getPolicy(
  db: Database,
  input: { ownerId?: string; ownerType?: "human" | "agent" },
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  return db.query.piAgentPolicies.findFirst({
    where: and(
      eq(piAgentPolicies.ownerId, targetOwner.ownerId),
      eq(piAgentPolicies.ownerType, targetOwner.ownerType),
    ),
  });
}

function isUsable(config: PiModelConfig) {
  return config.enabled && config.credentialStatus !== "invalid" && config.credentialStatus !== "missing";
}

export async function resolveModel(
  db: Database,
  input: ResolvePiModelInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const configs = await db.query.piAgentModelConfigs.findMany({
    where: and(
      eq(piAgentModelConfigs.ownerId, targetOwner.ownerId),
      eq(piAgentModelConfigs.ownerType, targetOwner.ownerType),
    ),
  });

  const requestedProvider = input.requestedPiProvider ?? null;
  const requestedModel = input.requestedPiModel ?? null;
  const requested = requestedProvider && requestedModel
    ? configs.find((config) => config.provider === requestedProvider && config.model === requestedModel)
    : undefined;
  const defaultConfig = configs.find((config) => config.isDefault && isUsable(config));
  const firstUsable = configs.find(isUsable);
  const fallback = defaultConfig ?? firstUsable;

  if (requested && isUsable(requested)) {
    return {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      requestedPiProvider: requestedProvider,
      requestedPiModel: requestedModel,
      actualPiProvider: requested.provider,
      actualPiModel: requested.model,
      fallbackReason: null,
      config: requested,
    };
  }

  if (fallback) {
    const fallbackReason = !requestedProvider && !requestedModel
      ? "no_requested_model"
      : requested
        ? `requested_model_${requested.enabled ? requested.credentialStatus : "disabled"}`
        : "requested_model_not_configured";
    return {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      requestedPiProvider: requestedProvider,
      requestedPiModel: requestedModel,
      actualPiProvider: fallback.provider,
      actualPiModel: fallback.model,
      fallbackReason,
      config: fallback,
    };
  }

  if (requestedProvider && requestedModel) {
    return {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      requestedPiProvider: requestedProvider,
      requestedPiModel: requestedModel,
      actualPiProvider: requestedProvider,
      actualPiModel: requestedModel,
      fallbackReason: "unconfigured_requested_model",
      config: null,
    };
  }

  throw new ValidationError("No usable Ti model configured for this owner");
}

async function validateRunTarget(db: Database, input: CreatePiAgentRunInput) {
  if (input.taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
    if (!task) throw new NotFoundError("Task not found");
    if (task.assignee !== input.assignedAgentId || task.assigneeType !== input.assignedAgentType) {
      throw new ValidationError("Ti agent runs can only be created for explicitly assigned tasks");
    }
  }
  if (input.scheduleRunId) {
    const run = await db.query.scheduleRuns.findFirst({
      where: eq(scheduleRuns.id, input.scheduleRunId),
      with: { generatedTask: true },
    });
    if (!run) throw new NotFoundError("Schedule run not found");
    const generatedTask = (run as typeof run & { generatedTask?: typeof tasks.$inferSelect | null }).generatedTask;
    if (generatedTask && (
      generatedTask.assignee !== input.assignedAgentId ||
      generatedTask.assigneeType !== input.assignedAgentType
    )) {
      throw new ValidationError("Ti agent runs can only be created for explicitly assigned schedule tasks");
    }
  }
}

export async function createRun(
  db: Database,
  input: CreatePiAgentRunInput,
  actor: Actor,
) {
  await validateRunTarget(db, input);
  const policy = await getPolicy(db, {}, actor);
  const model = await resolveModel(db, {
    requestedPiProvider: input.requestedPiProvider,
    requestedPiModel: input.requestedPiModel,
  }, actor);

  const [run] = await db
    .insert(piAgentRuns)
    .values({
      taskId: input.taskId,
      scheduleRunId: input.scheduleRunId,
      assignedAgentId: input.assignedAgentId,
      assignedAgentType: input.assignedAgentType,
      requestedPiProvider: model.requestedPiProvider,
      requestedPiModel: model.requestedPiModel,
      actualPiProvider: model.actualPiProvider,
      actualPiModel: model.actualPiModel,
      fallbackReason: model.fallbackReason,
      maxRetries: input.maxRetries ?? policy?.defaultMaxRetries ?? 0,
      createdBy: actor.id,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "pi_agent_run",
    entityId: run!.id,
    action: "queued",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      taskId: input.taskId,
      scheduleRunId: input.scheduleRunId,
      assignedAgentId: input.assignedAgentId,
      requestedPiProvider: model.requestedPiProvider,
      requestedPiModel: model.requestedPiModel,
      actualPiProvider: model.actualPiProvider,
      actualPiModel: model.actualPiModel,
      fallbackReason: model.fallbackReason,
    },
  });

  return run!;
}

export async function listRuns(db: Database, input: ListPiAgentRunsInput) {
  const conditions = [];
  if (input.taskId) conditions.push(eq(piAgentRuns.taskId, input.taskId));
  if (input.scheduleRunId) conditions.push(eq(piAgentRuns.scheduleRunId, input.scheduleRunId));
  if (input.assignedAgentId) conditions.push(eq(piAgentRuns.assignedAgentId, input.assignedAgentId));
  if (input.status) conditions.push(eq(piAgentRuns.status, input.status));

  return db.query.piAgentRuns.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    with: { task: true, scheduleRun: true },
    orderBy: (run, { desc }) => [desc(run.createdAt)],
    limit: input.limit,
  });
}

export async function acquireRun(
  db: Database,
  input: AcquirePiAgentRunInput,
  actor: Actor,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.durationMinutes * 60_000);
  const policy = await getPolicy(db, {}, actor);
  if (!policy || !policy.enabled || policy.executionMode === "disabled") {
    throw new ValidationError("Ti agent execution is disabled by policy");
  }

  const running = await db.query.piAgentRuns.findMany({
    where: and(
      eq(piAgentRuns.assignedAgentId, input.assignedAgentId),
      inArray(piAgentRuns.status, ["running", "in_review"]),
      or(isNull(piAgentRuns.leaseExpiresAt), sql`${piAgentRuns.leaseExpiresAt} > ${now.toISOString()}`),
    ),
    limit: policy.maxConcurrentRuns,
  });
  if (running.length >= policy.maxConcurrentRuns) {
    throw new ValidationError("Ti agent concurrency limit reached");
  }

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [usage] = await db
    .select({
      daily: sql<number>`count(*) FILTER (WHERE ${piAgentRuns.startedAt} >= ${dayStart.toISOString()})`,
      monthly: sql<number>`count(*) FILTER (WHERE ${piAgentRuns.startedAt} >= ${monthStart.toISOString()})`,
    })
    .from(piAgentRuns)
    .where(eq(piAgentRuns.assignedAgentId, input.assignedAgentId));
  if (policy.dailyRunLimit > 0 && Number(usage?.daily ?? 0) >= policy.dailyRunLimit) {
    throw new ValidationError("Ti agent daily run limit reached");
  }
  if (policy.monthlyRunLimit > 0 && Number(usage?.monthly ?? 0) >= policy.monthlyRunLimit) {
    throw new ValidationError("Ti agent monthly run limit reached");
  }

  const candidate = await db.query.piAgentRuns.findFirst({
    where: and(
      eq(piAgentRuns.assignedAgentId, input.assignedAgentId),
      or(
        and(
          eq(piAgentRuns.status, "queued"),
          or(isNull(piAgentRuns.nextAttemptAt), lte(piAgentRuns.nextAttemptAt, now)),
        ),
        and(
          inArray(piAgentRuns.status, ["running", "in_review"]),
          or(isNull(piAgentRuns.leaseExpiresAt), sql`${piAgentRuns.leaseExpiresAt} <= ${now.toISOString()}`),
        ),
      ),
    ),
    orderBy: [asc(piAgentRuns.createdAt)],
  });
  if (!candidate) return null;

  const [updated] = await db
    .update(piAgentRuns)
    .set({
      status: "running",
      leaseOwnerId: input.workerId,
      leaseOwnerType: actor.type,
      leaseExpiresAt: expiresAt,
      nextAttemptAt: null,
      startedAt: candidate.startedAt ?? now,
      updatedAt: now,
    })
    .where(and(
      eq(piAgentRuns.id, candidate.id),
      or(
        and(
          eq(piAgentRuns.status, "queued"),
          or(isNull(piAgentRuns.nextAttemptAt), lte(piAgentRuns.nextAttemptAt, now)),
        ),
        and(
          inArray(piAgentRuns.status, ["running", "in_review"]),
          or(isNull(piAgentRuns.leaseExpiresAt), sql`${piAgentRuns.leaseExpiresAt} <= ${now.toISOString()}`),
        ),
      ),
    ))
    .returning();

  if (!updated) return null;

  await db.insert(activityLog).values({
    entityType: "pi_agent_run",
    entityId: candidate.id,
    action: "acquired",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { workerId: input.workerId, expiresAt: expiresAt.toISOString() },
  });

  return updated!;
}

export async function heartbeatRunLease(
  db: Database,
  id: string,
  input: { workerId: string; durationMinutes: number },
  actor: Actor,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.durationMinutes * 60_000);
  const [updated] = await db
    .update(piAgentRuns)
    .set({ leaseExpiresAt: expiresAt, updatedAt: now })
    .where(and(
      eq(piAgentRuns.id, id),
      inArray(piAgentRuns.status, ["running", "in_review"]),
      eq(piAgentRuns.leaseOwnerId, input.workerId),
      eq(piAgentRuns.leaseOwnerType, actor.type),
      gt(piAgentRuns.leaseExpiresAt, now),
    ))
    .returning();

  if (!updated) {
    throw new ValidationError("Ti agent run lease is not held by this worker or has expired");
  }

  return updated;
}

export async function updateRunProgress(
  db: Database,
  id: string,
  input: {
    workerId: string;
    actualPiProvider?: string | null;
    actualPiModel?: string | null;
    piSessionId?: string | null;
    eventLog: unknown[];
    outputSummary?: string | null;
  },
  actor: Actor,
) {
  const now = new Date();
  const [updated] = await db
    .update(piAgentRuns)
    .set({
      status: "in_review",
      actualPiProvider: input.actualPiProvider ?? undefined,
      actualPiModel: input.actualPiModel ?? undefined,
      piSessionId: input.piSessionId ?? undefined,
      eventLog: input.eventLog,
      outputSummary: input.outputSummary ?? undefined,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(piAgentRuns.id, id),
      inArray(piAgentRuns.status, ["running", "in_review"]),
      eq(piAgentRuns.leaseOwnerId, input.workerId),
      eq(piAgentRuns.leaseOwnerType, actor.type),
      gt(piAgentRuns.leaseExpiresAt, now),
    ))
    .returning();

  if (!updated) {
    throw new ValidationError("Ti agent run progress requires an active lease held by this worker");
  }

  return updated;
}

export function piAgentRetryBackoffMs(
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 300_000,
) {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(normalizedAttempt - 1, 20));
}

export async function scheduleRunRetry(
  db: Database,
  id: string,
  input: { workerId: string; errorMessage: string; delayMs: number },
  actor: Actor,
) {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + input.delayMs);
  const [updated] = await db
    .update(piAgentRuns)
    .set({
      status: "queued",
      retryCount: sql`${piAgentRuns.retryCount} + 1`,
      nextAttemptAt,
      errorMessage: input.errorMessage.slice(0, 8000),
      leaseOwnerId: null,
      leaseOwnerType: null,
      leaseExpiresAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(piAgentRuns.id, id),
      inArray(piAgentRuns.status, ["running", "in_review"]),
      eq(piAgentRuns.leaseOwnerId, input.workerId),
      eq(piAgentRuns.leaseOwnerType, actor.type),
      gt(piAgentRuns.leaseExpiresAt, now),
      sql`${piAgentRuns.retryCount} < ${piAgentRuns.maxRetries}`,
    ))
    .returning();

  if (!updated) return null;

  await db.insert(activityLog).values({
    entityType: "pi_agent_run",
    entityId: id,
    action: "retry_scheduled",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      workerId: input.workerId,
      retryCount: updated.retryCount,
      nextAttemptAt: nextAttemptAt.toISOString(),
      errorMessage: input.errorMessage.slice(0, 1000),
    },
  });

  return updated;
}

export async function getRun(db: Database, id: string) {
  const run = await db.query.piAgentRuns.findFirst({
    where: eq(piAgentRuns.id, id),
    with: { task: true, scheduleRun: true },
  });
  if (!run) throw new NotFoundError("Ti agent run not found");
  return run;
}

export async function completeRun(
  db: Database,
  id: string,
  input: CompletePiAgentRunInput,
  actor: Actor,
) {
  const existing = await db.query.piAgentRuns.findFirst({ where: eq(piAgentRuns.id, id) });
  if (!existing) throw new NotFoundError("Ti agent run not found");
  if (existing.status === "cancelled" || existing.status === "succeeded") {
    throw new ValidationError("Terminal Ti agent runs cannot be completed again");
  }

  const [updated] = await db
    .update(piAgentRuns)
    .set({
      status: input.status,
      actualPiProvider: input.actualPiProvider ?? existing.actualPiProvider,
      actualPiModel: input.actualPiModel ?? existing.actualPiModel,
      piSessionId: input.piSessionId ?? existing.piSessionId,
      eventLog: input.eventLog ?? existing.eventLog,
      outputSummary: input.outputSummary ?? existing.outputSummary,
      errorMessage: input.errorMessage ?? existing.errorMessage,
      costMetadata: input.costMetadata ?? existing.costMetadata,
      nextAttemptAt: null,
      leaseOwnerId: null,
      leaseOwnerType: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(piAgentRuns.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "pi_agent_run",
    entityId: id,
    action: "completed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { status: input.status, errorMessage: input.errorMessage },
  });

  return updated!;
}
