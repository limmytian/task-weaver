import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  type Database,
  activityLog,
  tiAgentModelConfigs,
  tiAgentPolicies,
  tiAgentRuns,
  scheduleRuns,
  tasks,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  AcquireTiAgentRunInput,
  CompleteTiAgentRunInput,
  CreateTiAgentRunInput,
  ListTiAgentRunsInput,
  ListTiModelConfigsInput,
  ResolveTiModelInput,
  SetDefaultTiModelInput,
  UpsertTiAgentPolicyInput,
  UpsertTiModelConfigInput,
} from "@task-weaver/contracts";
import { NotFoundError, ValidationError, TI_SERVER_AGENT_ID } from "@task-weaver/contracts";

type TiModelConfig = typeof tiAgentModelConfigs.$inferSelect;

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

async function clearDefaultChat(
  db: Database,
  ownerId: string,
  ownerType: "human" | "agent",
  exceptConfigId?: string,
) {
  await db
    .update(tiAgentModelConfigs)
    .set({ isDefaultChat: false, updatedAt: new Date() })
    .where(
      and(
        eq(tiAgentModelConfigs.ownerId, ownerId),
        eq(tiAgentModelConfigs.ownerType, ownerType),
        exceptConfigId
          ? sql`${tiAgentModelConfigs.id} <> ${exceptConfigId}`
          : sql`true`,
      ),
    );
}

async function clearDefaultAgent(
  db: Database,
  ownerId: string,
  ownerType: "human" | "agent",
  exceptConfigId?: string,
) {
  await db
    .update(tiAgentModelConfigs)
    .set({ isDefaultAgent: false, updatedAt: new Date() })
    .where(
      and(
        eq(tiAgentModelConfigs.ownerId, ownerId),
        eq(tiAgentModelConfigs.ownerType, ownerType),
        exceptConfigId
          ? sql`${tiAgentModelConfigs.id} <> ${exceptConfigId}`
          : sql`true`,
      ),
    );
}

export async function upsertModelConfig(
  db: Database,
  input: UpsertTiModelConfigInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  if (input.isDefaultChat) {
    await clearDefaultChat(db, targetOwner.ownerId, targetOwner.ownerType);
  }
  if (input.isDefaultAgent) {
    await clearDefaultAgent(db, targetOwner.ownerId, targetOwner.ownerType);
  }

  const [config] = await db
    .insert(tiAgentModelConfigs)
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
      isDefaultChat: input.isDefaultChat,
      isDefaultAgent: input.isDefaultAgent,
      capabilities: input.capabilities,
      costMetadata: input.costMetadata ?? undefined,
      availabilityCheckedAt: input.availabilityCheckedAt,
    })
    .onConflictDoUpdate({
      target: [
        tiAgentModelConfigs.ownerId,
        tiAgentModelConfigs.ownerType,
        tiAgentModelConfigs.provider,
        tiAgentModelConfigs.model,
      ],
      set: stripUndefined({
        label: input.label,
        baseUrl: input.baseUrl,
        apiKeyRef: input.apiKeyRef,
        credentialStatus: input.credentialStatus,
        enabled: input.enabled,
        isDefaultChat: input.isDefaultChat,
        isDefaultAgent: input.isDefaultAgent,
        capabilities: input.capabilities,
        costMetadata: input.costMetadata ?? undefined,
        availabilityCheckedAt: input.availabilityCheckedAt,
        updatedAt: new Date(),
      }),
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "ti_agent_model_config",
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
      isDefaultChat: input.isDefaultChat,
      isDefaultAgent: input.isDefaultAgent,
    },
  });

  return config!;
}

export async function listModelConfigs(
  db: Database,
  input: ListTiModelConfigsInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const conditions = [
    eq(tiAgentModelConfigs.ownerId, targetOwner.ownerId),
    eq(tiAgentModelConfigs.ownerType, targetOwner.ownerType),
  ];
  if (!input.includeDisabled) conditions.push(eq(tiAgentModelConfigs.enabled, true));

  return db.query.tiAgentModelConfigs.findMany({
    where: and(...conditions),
    orderBy: (config, { desc, asc }) => [
      desc(config.isDefaultAgent),
      desc(config.isDefaultChat),
      asc(config.provider),
      asc(config.model),
    ],
  });
}

export async function setDefaultModel(
  db: Database,
  input: SetDefaultTiModelInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const config = await db.query.tiAgentModelConfigs.findFirst({
    where: and(
      eq(tiAgentModelConfigs.id, input.configId),
      eq(tiAgentModelConfigs.ownerId, targetOwner.ownerId),
      eq(tiAgentModelConfigs.ownerType, targetOwner.ownerType),
    ),
  });
  if (!config) throw new NotFoundError("Ti model config not found");
  if (!config.enabled) throw new ValidationError("Disabled Ti model configs cannot be default");

  const updates: { isDefaultChat?: boolean; isDefaultAgent?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (input.target === "chat" || input.target === "both") {
    await clearDefaultChat(db, targetOwner.ownerId, targetOwner.ownerType, config.id);
    updates.isDefaultChat = true;
  }
  if (input.target === "agent" || input.target === "both") {
    await clearDefaultAgent(db, targetOwner.ownerId, targetOwner.ownerType, config.id);
    updates.isDefaultAgent = true;
  }

  const [updated] = await db
    .update(tiAgentModelConfigs)
    .set(updates)
    .where(eq(tiAgentModelConfigs.id, config.id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "ti_agent_model_config",
    entityId: config.id,
    action: "default_set",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { provider: config.provider, model: config.model, target: input.target },
  });

  return updated!;
}

export async function upsertPolicy(
  db: Database,
  input: UpsertTiAgentPolicyInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const [policy] = await db
    .insert(tiAgentPolicies)
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
      sandboxTemplate: input.sandboxTemplate ?? null,
      allowNetwork: input.allowNetwork,
      allowedTools: input.allowedTools,
      deniedTools: input.deniedTools,
    })
    .onConflictDoUpdate({
      target: [tiAgentPolicies.ownerId, tiAgentPolicies.ownerType],
      set: stripUndefined({
        enabled: input.enabled,
        executionMode: input.executionMode,
        maxConcurrentRuns: input.maxConcurrentRuns,
        dailyRunLimit: input.dailyRunLimit,
        monthlyRunLimit: input.monthlyRunLimit,
        runTimeoutSeconds: input.runTimeoutSeconds,
        defaultMaxRetries: input.defaultMaxRetries,
        sandboxTemplate: input.sandboxTemplate ?? null,
        allowNetwork: input.allowNetwork,
        allowedTools: input.allowedTools,
        deniedTools: input.deniedTools,
        updatedAt: new Date(),
      }),
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "ti_agent_policy",
    entityId: policy!.id,
    action: "upserted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      enabled: input.enabled,
      executionMode: input.executionMode,
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
  return db.query.tiAgentPolicies.findFirst({
    where: and(
      eq(tiAgentPolicies.ownerId, targetOwner.ownerId),
      eq(tiAgentPolicies.ownerType, targetOwner.ownerType),
    ),
  });
}

function isUsable(config: TiModelConfig) {
  return config.enabled && config.credentialStatus !== "invalid" && config.credentialStatus !== "missing";
}

export async function resolveModel(
  db: Database,
  input: ResolveTiModelInput,
  actor: Actor,
) {
  const targetOwner = owner(input, actor);
  const configs = await db.query.tiAgentModelConfigs.findMany({
    where: and(
      eq(tiAgentModelConfigs.ownerId, targetOwner.ownerId),
      eq(tiAgentModelConfigs.ownerType, targetOwner.ownerType),
    ),
  });

  const requestedProvider = input.requestedProvider ?? null;
  const requestedModel = input.requestedModel ?? null;
  const requested = requestedProvider && requestedModel
    ? configs.find((config) => config.provider === requestedProvider && config.model === requestedModel)
    : undefined;

  const defaultPredicate = (config: TiModelConfig) =>
    input.target === "chat" ? config.isDefaultChat : config.isDefaultAgent;

  const defaultConfig = configs.find((config) => defaultPredicate(config) && isUsable(config));
  const fallbackDefault = configs.find((config) => (config.isDefaultAgent || config.isDefaultChat) && isUsable(config));
  const firstUsable = configs.find(isUsable);
  const fallback = defaultConfig ?? fallbackDefault ?? firstUsable;

  if (requested && isUsable(requested)) {
    return {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      requestedProvider,
      requestedModel,
      actualProvider: requested.provider,
      actualModel: requested.model,
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
      requestedProvider,
      requestedModel,
      actualProvider: fallback.provider,
      actualModel: fallback.model,
      fallbackReason,
      config: fallback,
    };
  }

  if (requestedProvider && requestedModel) {
    return {
      ownerId: targetOwner.ownerId,
      ownerType: targetOwner.ownerType,
      requestedProvider,
      requestedModel,
      actualProvider: requestedProvider,
      actualModel: requestedModel,
      fallbackReason: "unconfigured_requested_model",
      config: null,
    };
  }

  throw new ValidationError("No usable Ti model configured for this owner");
}

async function validateRunTarget(db: Database, input: CreateTiAgentRunInput) {
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
  input: CreateTiAgentRunInput,
  actor: Actor,
  modelOwner: Actor = actor,
) {
  await validateRunTarget(db, input);
  const policy = await getPolicy(db, {}, modelOwner);
  const model = await resolveModel(db, {
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    target: "agent",
  }, modelOwner);

  const [run] = await db
    .insert(tiAgentRuns)
    .values({
      taskId: input.taskId,
      scheduleRunId: input.scheduleRunId,
      assignedAgentId: input.assignedAgentId,
      assignedAgentType: input.assignedAgentType,
      requestedProvider: model.requestedProvider,
      requestedModel: model.requestedModel,
      actualProvider: model.actualProvider,
      actualModel: model.actualModel,
      fallbackReason: model.fallbackReason,
      workspacePolicy: input.workspacePolicy,
      maxRetries: input.maxRetries ?? policy?.defaultMaxRetries ?? 0,
      createdBy: actor.id,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "ti_agent_run",
    entityId: run!.id,
    action: "queued",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      taskId: input.taskId,
      scheduleRunId: input.scheduleRunId,
      assignedAgentId: input.assignedAgentId,
      requestedProvider: model.requestedProvider,
      requestedModel: model.requestedModel,
      actualProvider: model.actualProvider,
      actualModel: model.actualModel,
      fallbackReason: model.fallbackReason,
      workspacePolicy: input.workspacePolicy,
    },
  });

  return run!;
}

export async function listRuns(db: Database, input: ListTiAgentRunsInput, visibility?: SQL) {
  const conditions = [visibility];
  if (input.taskId) conditions.push(eq(tiAgentRuns.taskId, input.taskId));
  if (input.scheduleRunId) conditions.push(eq(tiAgentRuns.scheduleRunId, input.scheduleRunId));
  if (input.assignedAgentId) conditions.push(eq(tiAgentRuns.assignedAgentId, input.assignedAgentId));
  if (input.status) conditions.push(eq(tiAgentRuns.status, input.status));

  return db.query.tiAgentRuns.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    with: { task: true, scheduleRun: true },
    orderBy: (run, { desc }) => [desc(run.createdAt)],
    limit: input.limit,
  });
}

export async function acquireRun(
  db: Database,
  input: AcquireTiAgentRunInput,
  actor: Actor,
) {
  const assignedAgentId = input.assignedAgentId ?? TI_SERVER_AGENT_ID;
  const durationMinutes = input.durationMinutes ?? 15;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);
  const policy = await getPolicy(db, {}, actor);
  if (!policy || !policy.enabled || policy.executionMode === "disabled") {
    throw new ValidationError("Ti agent execution is disabled by policy");
  }

  const running = await db.query.tiAgentRuns.findMany({
    where: and(
      eq(tiAgentRuns.assignedAgentId, assignedAgentId),
      inArray(tiAgentRuns.status, ["running", "in_review"]),
      or(isNull(tiAgentRuns.leaseExpiresAt), sql`${tiAgentRuns.leaseExpiresAt} > ${now.toISOString()}`),
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
      daily: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= ${dayStart.toISOString()})`,
      monthly: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= ${monthStart.toISOString()})`,
    })
    .from(tiAgentRuns)
    .where(eq(tiAgentRuns.assignedAgentId, assignedAgentId));
  if (policy.dailyRunLimit > 0 && Number(usage?.daily ?? 0) >= policy.dailyRunLimit) {
    throw new ValidationError("Ti agent daily run limit reached");
  }
  if (policy.monthlyRunLimit > 0 && Number(usage?.monthly ?? 0) >= policy.monthlyRunLimit) {
    throw new ValidationError("Ti agent monthly run limit reached");
  }

  const candidate = await db.query.tiAgentRuns.findFirst({
    where: and(
      eq(tiAgentRuns.assignedAgentId, assignedAgentId),
      or(
        and(
          eq(tiAgentRuns.status, "queued"),
          or(isNull(tiAgentRuns.nextAttemptAt), lte(tiAgentRuns.nextAttemptAt, now)),
        ),
        and(
          inArray(tiAgentRuns.status, ["running", "in_review"]),
          or(isNull(tiAgentRuns.leaseExpiresAt), sql`${tiAgentRuns.leaseExpiresAt} <= ${now.toISOString()}`),
        ),
      ),
    ),
    orderBy: [asc(tiAgentRuns.createdAt)],
  });
  if (!candidate) return null;

  const [updated] = await db
    .update(tiAgentRuns)
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
      eq(tiAgentRuns.id, candidate.id),
      or(
        and(
          eq(tiAgentRuns.status, "queued"),
          or(isNull(tiAgentRuns.nextAttemptAt), lte(tiAgentRuns.nextAttemptAt, now)),
        ),
        and(
          inArray(tiAgentRuns.status, ["running", "in_review"]),
          or(isNull(tiAgentRuns.leaseExpiresAt), sql`${tiAgentRuns.leaseExpiresAt} <= ${now.toISOString()}`),
        ),
      ),
    ))
    .returning();

  if (!updated) return null;

  await db.insert(activityLog).values({
    entityType: "ti_agent_run",
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
    .update(tiAgentRuns)
    .set({ leaseExpiresAt: expiresAt, updatedAt: now })
    .where(and(
      eq(tiAgentRuns.id, id),
      inArray(tiAgentRuns.status, ["running", "in_review"]),
      eq(tiAgentRuns.leaseOwnerId, input.workerId),
      eq(tiAgentRuns.leaseOwnerType, actor.type),
      gt(tiAgentRuns.leaseExpiresAt, now),
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
    actualProvider?: string | null;
    actualModel?: string | null;
    sandboxSessionId?: string | null;
    tokenUsageId?: string | null;
    eventLog: unknown[];
    outputSummary?: string | null;
  },
  actor: Actor,
) {
  const now = new Date();
  const [updated] = await db
    .update(tiAgentRuns)
    .set({
      status: "in_review",
      actualProvider: input.actualProvider ?? undefined,
      actualModel: input.actualModel ?? undefined,
      sandboxSessionId: input.sandboxSessionId ?? undefined,
      tokenUsageId: input.tokenUsageId ?? undefined,
      eventLog: input.eventLog,
      outputSummary: input.outputSummary ?? undefined,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(tiAgentRuns.id, id),
      inArray(tiAgentRuns.status, ["running", "in_review"]),
      eq(tiAgentRuns.leaseOwnerId, input.workerId),
      eq(tiAgentRuns.leaseOwnerType, actor.type),
      gt(tiAgentRuns.leaseExpiresAt, now),
    ))
    .returning();

  if (!updated) {
    throw new ValidationError("Ti agent run progress requires an active lease held by this worker");
  }

  return updated;
}

export function tiAgentRetryBackoffMs(
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
    .update(tiAgentRuns)
    .set({
      status: "queued",
      retryCount: sql`${tiAgentRuns.retryCount} + 1`,
      nextAttemptAt,
      errorMessage: input.errorMessage.slice(0, 8000),
      leaseOwnerId: null,
      leaseOwnerType: null,
      leaseExpiresAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(tiAgentRuns.id, id),
      inArray(tiAgentRuns.status, ["running", "in_review"]),
      eq(tiAgentRuns.leaseOwnerId, input.workerId),
      eq(tiAgentRuns.leaseOwnerType, actor.type),
      gt(tiAgentRuns.leaseExpiresAt, now),
      sql`${tiAgentRuns.retryCount} < ${tiAgentRuns.maxRetries}`,
    ))
    .returning();

  if (!updated) return null;

  await db.insert(activityLog).values({
    entityType: "ti_agent_run",
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
  const run = await db.query.tiAgentRuns.findFirst({
    where: eq(tiAgentRuns.id, id),
    with: { task: true, scheduleRun: true },
  });
  if (!run) throw new NotFoundError("Ti agent run not found");
  return run;
}

export async function completeRun(
  db: Database,
  id: string,
  input: CompleteTiAgentRunInput,
  actor: Actor,
) {
  const existing = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, id) });
  if (!existing) throw new NotFoundError("Ti agent run not found");
  if (existing.status === "cancelled" || existing.status === "succeeded") {
    throw new ValidationError("Terminal Ti agent runs cannot be completed again");
  }

  const [updated] = await db
    .update(tiAgentRuns)
    .set({
      status: input.status,
      actualProvider: input.actualProvider ?? existing.actualProvider,
      actualModel: input.actualModel ?? existing.actualModel,
      sandboxSessionId: input.sandboxSessionId ?? existing.sandboxSessionId,
      tokenUsageId: input.tokenUsageId ?? existing.tokenUsageId,
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
    .where(eq(tiAgentRuns.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "ti_agent_run",
    entityId: id,
    action: "completed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { status: input.status, errorMessage: input.errorMessage },
  });

  return updated!;
}
