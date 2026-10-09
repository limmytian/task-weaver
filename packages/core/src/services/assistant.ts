import { authorizeMetadataOperation, schedulePredicate } from "./metadata-authorization";
import { mcpServerPredicate } from "./mcp-authorization";
import { createResourceServices } from './resource-services';
import { getLiveRequestAuthority } from './api-keys';
import { lockIdentityLifecycle } from './auth-security';
import { resourcePredicate, taskResourcePredicate, memoryResourcePredicate, requireResource } from './resource-authorization';
import { AuthorizationError, type VerifiedRequestContext } from '@task-weaver/contracts';
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type Database,
  activityLog,
  assistantActions,
  assistantConversations,
  assistantMessages,
  documents,
  mcpServers,
  mcpTools,
  memories,
  tiAgentPolicies,
  tiAgentRuns,
  projects,
  requirements,
  schedules,
  tasks,
} from "@task-weaver/db";
import { NotFoundError, ValidationError, assistantActionProposalSchema } from "@task-weaver/contracts";
import type { Actor } from "@task-weaver/contracts";
import type {
  BuildAssistantContextInput,
  AssistantActionProposal,
  CreateAssistantActionInput,
  CreateAssistantConversationInput,
  CreateAssistantMessageInput,
  ListAssistantConversationsInput,
  RenameAssistantConversationInput,
  SendAssistantMessageInput,
  UpdateAssistantActionStatusInput,
} from "@task-weaver/contracts";
import type { TaskStatus } from "@task-weaver/contracts";
import { resolveModel } from "./ti-agent";


const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization)/i;

type ProjectRow = typeof projects.$inferSelect;
type RequirementRow = typeof requirements.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ScheduleRow = typeof schedules.$inferSelect;
type AssistantActionRow = typeof assistantActions.$inferSelect;
type ResolvedTiModel = Awaited<ReturnType<typeof resolveModel>>;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    text?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

function truncate(value: string | null | undefined, limit: number) {
  if (!value) return value ?? null;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function resolveApiKey(ref: string | null | undefined, provider: string) {
  const normalizedRef = ref?.trim();
  const candidates = [];

  if (normalizedRef?.startsWith("env://")) candidates.push(normalizedRef.slice("env://".length));
  else if (normalizedRef?.startsWith("env:")) candidates.push(normalizedRef.slice("env:".length));
  else if (normalizedRef && /^[A-Z][A-Z0-9_]*$/.test(normalizedRef)) candidates.push(normalizedRef);
  else if (normalizedRef?.startsWith("sk-")) return normalizedRef;

  candidates.push(`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`);
  if (provider === "openai") candidates.push("OPENAI_API_KEY");

  const env = globalThis.process?.env ?? {};
  const keyName = candidates.find((candidate) => env[candidate]);
  if (!keyName) {
    throw new ValidationError(`No API key found for ${provider}. Set apiKeyRef to an environment variable name.`);
  }
  return env[keyName]!;
}

function resolveBaseUrl(baseUrl: string | null | undefined, provider: string) {
  if (baseUrl) return baseUrl.replace(/\/+$/, "");
  if (provider === "openai") return "https://api.openai.com/v1";
  throw new ValidationError(`No base URL configured for ${provider}`);
}

function buildModelPrompt(contextSnapshot: Record<string, unknown>, message: string, workflow?: string) {
  return [
    `User request: ${message}`,
    workflow ? `Workflow shortcut: ${workflow}` : null,
    "Use the Task Weaver context below. Be concise, concrete, and call out uncertainty.",
    "Do not claim to have changed data unless an approved action has actually executed.",
    JSON.stringify(redactValue(contextSnapshot), null, 2),
  ].filter(Boolean).join("\n\n").slice(0, 24_000);
}

async function generateModelResponse(
  resolved: ResolvedTiModel,
  contextSnapshot: Record<string, unknown>,
  input: SendAssistantMessageInput,
) {
  if (!resolved.config) throw new ValidationError("Resolved Ti model has no stored configuration");

  const provider = resolved.config.provider;
  const baseUrl = resolveBaseUrl(resolved.config.baseUrl, provider);
  const apiKey = resolveApiKey(resolved.config.apiKeyRef, provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolved.config.model,
        messages: [
          {
            role: "system",
            content: "You are the Task Weaver assistant inside a project management app. Answer from the provided context and propose reviewable next steps when useful.",
          },
          {
            role: "user",
            content: buildModelPrompt(contextSnapshot, input.message, input.workflow),
          },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({})) as ChatCompletionResponse;
    if (!response.ok) {
      throw new ValidationError(payload.error?.message ?? `Model request failed with ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text;
    if (!content?.trim()) throw new ValidationError("Model response did not include assistant content");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(fieldValue),
    ]),
  );
}

function compactProject(project: ProjectRow | null) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    updatedAt: project.updatedAt,
  };
}

function compactRequirement(requirement: RequirementRow | null, textChars: number) {
  if (!requirement) return null;
  return {
    id: requirement.id,
    projectId: requirement.projectId,
    title: requirement.title,
    description: truncate(requirement.description, textChars),
    status: requirement.status,
    priority: requirement.priority,
    modelTier: requirement.modelTier,
    tags: requirement.tags,
    branchName: requirement.branchName,
    updatedAt: requirement.updatedAt,
  };
}

function compactTask(task: TaskRow | null, textChars: number) {
  if (!task) return null;
  return {
    id: task.id,
    scope: task.scope,
    projectId: task.projectId,
    requirementId: task.requirementId,
    executionSliceId: task.executionSliceId,
    title: task.title,
    description: truncate(task.description, textChars),
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    assigneeType: task.assigneeType,
    tags: task.tags,
    expectedAt: task.expectedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}

function compactSchedule(schedule: ScheduleRow | null, textChars: number) {
  if (!schedule) return null;
  return {
    id: schedule.id,
    projectId: schedule.projectId,
    requirementId: schedule.requirementId,
    targetScope: schedule.targetScope,
    kind: schedule.kind,
    title: schedule.title,
    description: truncate(schedule.description, textChars),
    status: schedule.status,
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    taskTitle: schedule.taskTitle,
    autoRun: schedule.autoRun,
    assignedExecutor: schedule.assignedExecutor,
    assignedExecutorType: schedule.assignedExecutorType,
    requestedProvider: schedule.requestedProvider,
    requestedModel: schedule.requestedModel,
    updatedAt: schedule.updatedAt,
  };
}

function textSearchCondition(table: { title: unknown; content?: unknown; summary?: unknown }, text: string) {
  const pattern = `%${text}%`;
  const conditions = [sql`${table.title} ILIKE ${pattern}`];
  if (table.content) conditions.push(sql`${table.content} ILIKE ${pattern}`);
  if (table.summary) conditions.push(sql`${table.summary} ILIKE ${pattern}`);
  return or(...conditions);
}

async function resolveScope(db: Database, input: BuildAssistantContextInput) {
  let project: ProjectRow | null = null;
  let requirement: RequirementRow | null = null;
  let task: TaskRow | null = null;
  let schedule: ScheduleRow | null = null;

  if (input.taskId) {
    task = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) }) ?? null;
    if (!task) throw new NotFoundError("Task not found");
  }

  if (input.scheduleId) {
    schedule = await db.query.schedules.findFirst({ where: eq(schedules.id, input.scheduleId) }) ?? null;
    if (!schedule) throw new NotFoundError("Schedule not found");
  }

  const requirementId = input.requirementId ?? task?.requirementId ?? schedule?.requirementId ?? undefined;
  if (requirementId) {
    requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) }) ?? null;
    if (!requirement) throw new NotFoundError("Requirement not found");
  }

  const projectId = input.projectId ?? task?.projectId ?? schedule?.projectId ?? requirement?.projectId ?? undefined;
  if (projectId) {
    project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) }) ?? null;
    if (!project) throw new NotFoundError("Project not found");
  }

  if (task?.projectId && project?.id && task.projectId !== project.id) {
    throw new ValidationError("Task does not belong to the requested project");
  }
  if (requirement?.projectId && project?.id && requirement.projectId !== project.id) {
    throw new ValidationError("Requirement does not belong to the requested project");
  }
  if (task?.requirementId && requirement?.id && task.requirementId !== requirement.id) {
    throw new ValidationError("Task does not belong to the requested requirement");
  }
  if (schedule?.projectId && project?.id && schedule.projectId !== project.id) {
    throw new ValidationError("Schedule does not belong to the requested project");
  }

  return { project, requirement, task, schedule };
}

function projectOrGlobalCondition(projectId: string | undefined, includeGlobal: boolean) {
  if (!projectId) return isNull(documents.projectId);
  return includeGlobal
    ? or(eq(documents.projectId, projectId), isNull(documents.projectId))!
    : eq(documents.projectId, projectId);
}

export async function buildAssistantContext(
  db: Database,
  input: BuildAssistantContextInput,
  actor: Actor,
  identity?: VerifiedRequestContext,
) {
  if (!identity) throw new AuthorizationError();
  const authority = await getLiveRequestAuthority(db, identity);
  const limits = input.limits;
  const scope = await resolveScope(db, input);
  const projectId = scope.project?.id;
  const intent = input.intent?.trim();

  const requirementRows = projectId && limits.requirements > 0
    ? await db.query.requirements.findMany({
      where: and(eq(requirements.projectId, projectId), resourcePredicate(authority, requirements)),
      orderBy: (requirement, { desc }) => [desc(requirement.updatedAt)],
      limit: limits.requirements,
    })
    : [];

  const taskConditions = [];
  if (scope.requirement?.id) taskConditions.push(eq(tasks.requirementId, scope.requirement.id));
  else if (projectId) taskConditions.push(eq(tasks.projectId, projectId));

  const taskRows = taskConditions.length > 0 && limits.tasks > 0
    ? await db.query.tasks.findMany({
      where: and(...taskConditions, taskResourcePredicate(authority)),
      orderBy: (task, { desc }) => [desc(task.updatedAt)],
      limit: limits.tasks,
    })
    : [];

  const scheduleConditions = [];
  if (scope.requirement?.id) scheduleConditions.push(eq(schedules.requirementId, scope.requirement.id));
  else if (projectId) scheduleConditions.push(eq(schedules.projectId, projectId));

  const scheduleRows = scheduleConditions.length > 0 && limits.schedules > 0
    ? await db.query.schedules.findMany({
      where: and(...scheduleConditions, schedulePredicate(authority)),
      orderBy: (schedule, { desc }) => [desc(schedule.updatedAt)],
      limit: limits.schedules,
    })
    : [];

  const docConditions = [projectOrGlobalCondition(projectId, input.includeGlobal), resourcePredicate(authority, documents)];
  if (intent) docConditions.push(textSearchCondition(documents, intent)!);
  const documentRows = limits.documents > 0
    ? await db
      .select({
        id: documents.id,
        projectId: documents.projectId,
        title: documents.title,
        summary: documents.summary,
        keywords: documents.keywords,
        tags: documents.tags,
        docType: documents.docType,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(...docConditions))
      .orderBy(desc(documents.updatedAt))
      .limit(limits.documents)
    : [];

  const memoryScopes = [];
  if (projectId) {
    memoryScopes.push(eq(memories.projectId, projectId));
    if (input.includeGlobal) memoryScopes.push(and(isNull(memories.projectId), isNull(memories.personalOwnerId))!);
  } else {
    memoryScopes.push(and(isNull(memories.projectId), isNull(memories.personalOwnerId))!);
  }
  if (input.includePersonal) {
    memoryScopes.push(
      and(
        isNull(memories.projectId),
        eq(memories.personalOwnerId, actor.id),
        eq(memories.personalOwnerType, actor.type),
      )!,
    );
  }

  const memoryConditions = [
    or(...memoryScopes)!,
    memoryResourcePredicate(authority),
    or(isNull(memories.expiresAt), sql`${memories.expiresAt} > now()`)!,
  ];
  if (intent) memoryConditions.push(textSearchCondition(memories, intent)!);
  const memoryRows = limits.memories > 0
    ? await db
      .select({
        id: memories.id,
        projectId: memories.projectId,
        personalOwnerId: memories.personalOwnerId,
        personalOwnerType: memories.personalOwnerType,
        memoryType: memories.memoryType,
        title: memories.title,
        content: memories.content,
        tags: memories.tags,
        entityType: memories.entityType,
        entityId: memories.entityId,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(and(...memoryConditions))
      .orderBy(desc(memories.updatedAt))
      .limit(limits.memories)
    : [];

  const mcpScope = projectId
    ? or(eq(mcpServers.projectId, projectId), isNull(mcpServers.projectId))!
    : isNull(mcpServers.projectId);
  const mcpRows = limits.mcpTools > 0
    ? await db
      .select({
        id: mcpTools.id,
        name: mcpTools.name,
        description: mcpTools.description,
        tags: mcpTools.tags,
        serverId: mcpServers.id,
        serverName: mcpServers.name,
        serverStatus: mcpServers.status,
        projectId: mcpServers.projectId,
        transport: mcpServers.transport,
      })
      .from(mcpTools)
      .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
      .where(and(eq(mcpServers.active, true), mcpScope, mcpServerPredicate(authority, identity)))
      .limit(limits.mcpTools)
    : [];

  const tiPolicy = await db.query.tiAgentPolicies.findFirst({
    where: and(eq(tiAgentPolicies.ownerId, actor.id), eq(tiAgentPolicies.ownerType, actor.type)),
  });

  const tiRunConditions = [inArray(tiAgentRuns.status, ["failed", "in_review"])];
  if (taskRows.length > 0) {
    tiRunConditions.push(inArray(tiAgentRuns.taskId, taskRows.map((row) => row.id)));
  } else if (scope.task?.id) {
    tiRunConditions.push(eq(tiAgentRuns.taskId, scope.task.id));
  }
  const tiRunRows = limits.tiRuns > 0 && tiRunConditions.length > 1
    ? await db.query.tiAgentRuns.findMany({
      where: and(...tiRunConditions),
      orderBy: (run, { desc }) => [desc(run.updatedAt)],
      limit: limits.tiRuns,
    })
    : [];

  const recentActivity = projectId && !authority.bounds && authority.grants.some(g => g.scope === "project" && g.projectId === projectId && g.permissions.includes("audit.read")) && limits.recentActivity > 0
    ? await db
      .select()
      .from(activityLog)
      .where(
        sql`(
          (${activityLog.entityType} = 'project' AND ${activityLog.entityId} = ${projectId})
          OR (${activityLog.entityType} = 'requirement' AND ${activityLog.entityId} IN (SELECT id FROM requirements WHERE project_id = ${projectId}))
          OR (${activityLog.entityType} = 'task' AND ${activityLog.entityId} IN (SELECT id FROM tasks WHERE project_id = ${projectId}))
          OR (${activityLog.entityType} = 'document' AND ${activityLog.entityId} IN (SELECT id FROM documents WHERE project_id = ${projectId}))
          OR (${activityLog.entityType} = 'schedule' AND ${activityLog.entityId} IN (SELECT id FROM schedules WHERE project_id = ${projectId}))
        )`,
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(limits.recentActivity)
    : [];

  const recentMessages = input.conversationId && limits.recentMessages > 0
    ? await db.query.assistantMessages.findMany({
      where: eq(assistantMessages.conversationId, input.conversationId),
      orderBy: (message, { desc }) => [desc(message.createdAt)],
      limit: limits.recentMessages,
    })
    : [];

  return redactValue({
    assembledAt: new Date().toISOString(),
    actor,
    contextKind: input.contextKind,
    current: {
      project: compactProject(scope.project),
      requirement: compactRequirement(scope.requirement, limits.textChars),
      task: compactTask(scope.task, limits.textChars),
      schedule: compactSchedule(scope.schedule, limits.textChars),
    },
    projectState: {
      requirements: requirementRows.map((row) => compactRequirement(row, limits.textChars)),
      tasks: taskRows.map((row) => compactTask(row, limits.textChars)),
      schedules: scheduleRows.map((row) => compactSchedule(row, limits.textChars)),
    },
    retrieval: {
      documents: documentRows.map((row) => ({
        ...row,
        summary: truncate(row.summary, limits.textChars),
      })),
      memories: memoryRows.map((row) => ({
        ...row,
        content: truncate(row.content, limits.textChars),
      })),
      mcpTools: mcpRows,
    },
    tiAgent: {
      policy: tiPolicy ? redactValue(tiPolicy) : null,
      recentFailures: tiRunRows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        scheduleRunId: row.scheduleRunId,
        status: row.status,
        requestedProvider: row.requestedProvider,
        requestedModel: row.requestedModel,
        actualProvider: row.actualProvider,
        actualModel: row.actualModel,
        outputSummary: truncate(row.outputSummary, limits.textChars),
        errorMessage: truncate(row.errorMessage, limits.textChars),
        updatedAt: row.updatedAt,
      })),
    },
    conversation: {
      recentMessages: recentMessages.reverse().map((message) => ({
        id: message.id,
        role: message.role,
        content: truncate(message.content, limits.textChars),
        provider: message.provider,
        model: message.model,
        createdAt: message.createdAt,
      })),
    },
    recentActivity: recentActivity.map((entry) => ({
      ...entry,
      metadata: redactValue(entry.metadata),
    })),
  });
}

export async function createConversation(
  db: Database,
  input: CreateAssistantConversationInput,
  actor: Actor,
) {
  const [conversation] = await db
    .insert(assistantConversations)
    .values({
      projectId: input.projectId ?? null,
      requirementId: input.requirementId ?? null,
      taskId: input.taskId ?? null,
      scheduleId: input.scheduleId ?? null,
      title: input.title ?? null,
      contextKind: input.contextKind,
      createdBy: actor.id,
      createdByType: actor.type,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "assistant_conversation",
    entityId: conversation!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      projectId: input.projectId ?? null,
      requirementId: input.requirementId ?? null,
      taskId: input.taskId ?? null,
      scheduleId: input.scheduleId ?? null,
      contextKind: input.contextKind,
    },
  });

  return conversation!;
}

export async function listConversations(
  db: Database,
  input: ListAssistantConversationsInput,
  actor: Actor,
) {
  const conditions = [
    eq(assistantConversations.createdBy, actor.id),
    eq(assistantConversations.createdByType, actor.type),
  ];

  if (input.projectId !== undefined) {
    conditions.push(
      input.projectId === null
        ? isNull(assistantConversations.projectId)
        : eq(assistantConversations.projectId, input.projectId),
    );
  }
  if (input.requirementId !== undefined) {
    conditions.push(
      input.requirementId === null
        ? isNull(assistantConversations.requirementId)
        : eq(assistantConversations.requirementId, input.requirementId),
    );
  }
  if (input.taskId !== undefined) {
    conditions.push(
      input.taskId === null
        ? isNull(assistantConversations.taskId)
        : eq(assistantConversations.taskId, input.taskId),
    );
  }
  if (input.scheduleId !== undefined) {
    conditions.push(
      input.scheduleId === null
        ? isNull(assistantConversations.scheduleId)
        : eq(assistantConversations.scheduleId, input.scheduleId),
    );
  }
  if (input.contextKind) {
    conditions.push(eq(assistantConversations.contextKind, input.contextKind));
  }

  return db.query.assistantConversations.findMany({
    where: and(...conditions),
    orderBy: (c, { desc }) => [desc(sql`COALESCE(${c.lastMessageAt}, ${c.createdAt})`)],
    limit: input.limit,
    offset: input.offset,
  });
}

export async function getConversation(
  db: Database,
  id: string,
  actor: Actor,
) {
  const conversation = await db.query.assistantConversations.findFirst({
    where: and(
      eq(assistantConversations.id, id),
      eq(assistantConversations.createdBy, actor.id),
      eq(assistantConversations.createdByType, actor.type),
    ),
  });
  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  const messages = await db.query.assistantMessages.findMany({
    where: eq(assistantMessages.conversationId, id),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });

  const actions = await db.query.assistantActions.findMany({
    where: eq(assistantActions.conversationId, id),
    orderBy: (a, { asc }) => [asc(a.createdAt)],
  });

  return {
    conversation,
    messages,
    actions,
  };
}

export async function renameConversation(
  db: Database,
  input: RenameAssistantConversationInput,
  actor: Actor,
) {
  const conversation = await db.query.assistantConversations.findFirst({
    where: and(
      eq(assistantConversations.id, input.id),
      eq(assistantConversations.createdBy, actor.id),
      eq(assistantConversations.createdByType, actor.type),
    ),
  });
  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  const [updated] = await db
    .update(assistantConversations)
    .set({ title: input.title, updatedAt: new Date() })
    .where(eq(assistantConversations.id, input.id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "assistant_conversation",
    entityId: input.id,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { title: input.title },
  });

  return updated!;
}

export async function deleteConversation(
  db: Database,
  id: string,
  actor: Actor,
) {
  const conversation = await db.query.assistantConversations.findFirst({
    where: and(
      eq(assistantConversations.id, id),
      eq(assistantConversations.createdBy, actor.id),
      eq(assistantConversations.createdByType, actor.type),
    ),
  });
  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  await db
    .delete(assistantConversations)
    .where(eq(assistantConversations.id, id));

  await db.insert(activityLog).values({
    entityType: "assistant_conversation",
    entityId: id,
    action: "deleted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { title: conversation.title },
  });

  return { success: true };
}

export async function createMessage(
  db: Database,
  input: CreateAssistantMessageInput,
  actor: Actor,
) {
  const conversation = await db.query.assistantConversations.findFirst({
    where: eq(assistantConversations.id, input.conversationId),
  });
  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  const now = new Date();
  const [message] = await db
    .insert(assistantMessages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      contextSnapshot: input.contextSnapshot ?? null,
      tiAgentRunId: input.tiAgentRunId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      metadata: input.metadata ?? null,
      createdBy: actor.id,
      createdByType: actor.type,
    })
    .returning();

  await db
    .update(assistantConversations)
    .set({ lastMessageAt: now, updatedAt: now })
    .where(eq(assistantConversations.id, input.conversationId));

  await db.insert(activityLog).values({
    entityType: "assistant_message",
    entityId: message!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      conversationId: input.conversationId,
      role: input.role,
      tiAgentRunId: input.tiAgentRunId ?? null,
    },
  });

  return message!;
}

export async function createAction(
  db: Database,
  input: CreateAssistantActionInput,
  actor: Actor,
) {
  const conversation = await db.query.assistantConversations.findFirst({
    where: eq(assistantConversations.id, input.conversationId),
  });
  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  const [action] = await db
    .insert(assistantActions)
    .values({
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      actionType: input.actionType,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      payload: input.payload,
      preview: input.preview ?? null,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "assistant_action",
    entityId: action!.id,
    action: "proposed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      actionType: input.actionType,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
    },
  });

  return action!;
}

function targetForProposal(proposal: AssistantActionProposal) {
  switch (proposal.actionType) {
    case "create_task":
      return { targetType: "requirement" as const, targetId: proposal.payload.requirementId };
    case "update_task":
    case "add_comment":
    case "add_note":
      return { targetType: "task" as const, targetId: proposal.payload.taskId };
    case "create_schedule":
      return proposal.payload.requirementId
        ? { targetType: "requirement" as const, targetId: proposal.payload.requirementId }
        : proposal.payload.projectId
          ? { targetType: "project" as const, targetId: proposal.payload.projectId }
          : { targetType: null, targetId: null };
    case "pause_schedule":
      return { targetType: "schedule" as const, targetId: proposal.payload.scheduleId };
    case "queue_ti_run":
      return proposal.payload.taskId
        ? { targetType: "task" as const, targetId: proposal.payload.taskId }
        : proposal.payload.scheduleRunId
          ? { targetType: null, targetId: proposal.payload.scheduleRunId }
          : { targetType: null, targetId: null };
    case "draft_document":
      return proposal.payload.projectId
        ? { targetType: "project" as const, targetId: proposal.payload.projectId }
        : { targetType: null, targetId: null };
  }
}

function previewForProposal(proposal: AssistantActionProposal) {
  if (proposal.preview) return proposal.preview;
  switch (proposal.actionType) {
    case "create_task":
      return `Create task "${proposal.payload.title}" in requirement ${proposal.payload.requirementId}.`;
    case "update_task": {
      const changes = [
        proposal.payload.status ? `status -> ${proposal.payload.status}` : null,
        proposal.payload.priority ? `priority -> ${proposal.payload.priority}` : null,
        proposal.payload.title ? `title -> ${proposal.payload.title}` : null,
      ].filter(Boolean).join(", ");
      return `Update task ${proposal.payload.taskId}${changes ? `: ${changes}` : ""}.`;
    }
    case "create_schedule":
      return `Create ${proposal.payload.kind} schedule "${proposal.payload.title}".`;
    case "pause_schedule":
      return `Pause schedule ${proposal.payload.scheduleId}.`;
    case "queue_ti_run":
      return `Queue Ti agent run for ${proposal.payload.taskId ? `task ${proposal.payload.taskId}` : `schedule run ${proposal.payload.scheduleRunId}`}.`;
    case "add_comment":
      return `Add comment to task ${proposal.payload.taskId}.`;
    case "add_note":
      return `Add ${proposal.payload.pinned ? "pinned " : ""}note to task ${proposal.payload.taskId}.`;
    case "draft_document":
      return `Create reviewable document draft "${proposal.payload.title}".`;
  }
}

export async function createProposedAction(
  db: Database,
  conversationId: string,
  messageId: string | null,
  proposal: AssistantActionProposal,
  actor: Actor,
) {
  const target = targetForProposal(proposal);
  return createAction(db, {
    conversationId,
    messageId,
    actionType: proposal.actionType,
    targetType: target.targetType,
    targetId: target.targetId,
    payload: proposal.payload,
    preview: previewForProposal(proposal),
  }, actor);
}

export async function updateActionStatus(
  db: Database,
  id: string,
  input: UpdateAssistantActionStatusInput,
  actor: Actor,
) {
  const existing = await db.query.assistantActions.findFirst({
    where: eq(assistantActions.id, id),
  });
  if (!existing) throw new NotFoundError("Assistant action not found");

  const now = new Date();
  const [updated] = await db
    .update(assistantActions)
    .set({
      status: input.status,
      approvalActorId: input.status === "approved" ? actor.id : existing.approvalActorId,
      approvalActorType: input.status === "approved" ? actor.type : existing.approvalActorType,
      approvedAt: input.status === "approved" ? now : existing.approvedAt,
      executionResult: input.executionResult ?? existing.executionResult,
      activityLogId: input.activityLogId ?? existing.activityLogId,
      errorMessage: input.errorMessage ?? existing.errorMessage,
      executedAt: ["succeeded", "failed", "cancelled"].includes(input.status) ? now : existing.executedAt,
      updatedAt: now,
    })
    .where(eq(assistantActions.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "assistant_action",
    entityId: id,
    action: input.status,
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      conversationId: existing.conversationId,
      actionType: existing.actionType,
      targetType: existing.targetType,
      targetId: existing.targetId,
      activityLogId: input.activityLogId ?? null,
    },
  });

  return updated!;
}

function proposalFromAction(action: AssistantActionRow): AssistantActionProposal {
  const parsed = {
    actionType: action.actionType,
    payload: action.payload,
    preview: action.preview ?? undefined,
  };
  const validated = assistantActionProposalSchema.safeParse(parsed);
  if (!validated.success) throw new ValidationError("Invalid assistant action payload");
  return validated.data;
}

async function executeActionPayload(
  db: Database,
  action: AssistantActionRow,
  actor: Actor,
  services: ReturnType<typeof createResourceServices>,
) {
  const proposal = proposalFromAction(action);

  switch (proposal.actionType) {
    case "create_task": {
      const result = await services.taskService.createTask(db, proposal.payload, actor);
      return { entityType: "task", entityId: result.id, result };
    }
    case "update_task": {
      const { taskId, status, reason, force, ...updates } = proposal.payload;
      let result = Object.keys(updates).length > 0
        ? await services.taskService.updateTask(db, taskId, updates, actor)
        : await services.taskService.getTask(db, taskId);
      if (status) {
        result = await services.taskService.updateTaskStatus(db, taskId, status as TaskStatus, actor, reason, force);
      }
      return { entityType: "task", entityId: taskId, result };
    }
    case "create_schedule": {
      const result = await services.scheduleService.createSchedule(db, proposal.payload, actor);
      return { entityType: "schedule", entityId: result.id, result };
    }
    case "pause_schedule": {
      const result = await services.scheduleService.updateSchedule(db, proposal.payload.scheduleId, { status: "paused" }, actor);
      return { entityType: "schedule", entityId: result.id, result };
    }
    case "queue_ti_run": {
      const result = await services.tiAgentService.createRun(db, proposal.payload, actor);
      return { entityType: "ti_agent_run", entityId: result.id, result };
    }
    case "add_comment": {
      const result = await services.taskService.addTaskComment(db, proposal.payload.taskId, proposal.payload.content, actor);
      return { entityType: "task", entityId: proposal.payload.taskId, result };
    }
    case "add_note": {
      const result = await services.taskService.addTaskNote(db, proposal.payload.taskId, proposal.payload.content, proposal.payload.pinned, actor);
      return { entityType: "task", entityId: proposal.payload.taskId, result };
    }
    case "draft_document": {
      const result = await services.documentService.createDocument(db, {
        ...proposal.payload,
        generatedBy: proposal.payload.generatedBy ?? "assistant",
        generationPrompt: proposal.payload.generationPrompt ?? action.preview ?? undefined,
        needsReview: true,
      }, actor);
      return { entityType: "document", entityId: result.id, result };
    }
  }
}

/** Approval is intent, not a stored permission bypass. Recheck each payload target through core. */
export async function executeApprovedAction(
  db: Database,
  id: string,
  actor: Actor,
  context?: VerifiedRequestContext,
) {
  if (!context) throw new AuthorizationError();
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await getLiveRequestAuthority(tx, context);
    if (authority.bounds || actor.id !== authority.actor.id || actor.type !== authority.actor.type) throw new AuthorizationError();
    const action = await tx.query.assistantActions.findFirst({ where: eq(assistantActions.id, id) });
    const conversation = action && await tx.query.assistantConversations.findFirst({ where: eq(assistantConversations.id, action.conversationId) });
    if (!action || !conversation || conversation.createdBy !== actor.id || conversation.createdByType !== actor.type) throw new NotFoundError("Resource not found");
    for (const [kind, resourceId] of [["project", conversation.projectId], ["requirement", conversation.requirementId], ["task", conversation.taskId]] as const) {
      if (resourceId) await requireResource(tx as unknown as Database, authority, kind, resourceId);
    }
    if (!["proposed", "approved"].includes(action.status)) throw new ValidationError("Assistant action cannot execute from its current status");
    // No caller can supply approval identity, execution results, force flags, or completion state.
    const proposal = proposalFromAction(action);
    if (proposal.actionType === 'update_task' && proposal.payload.force) throw new AuthorizationError();
    await updateActionStatus(tx as unknown as Database, id, { status: "approved" }, actor);
    await updateActionStatus(tx as unknown as Database, id, { status: "executing" }, actor);
    const execution = await executeActionPayload(tx as unknown as Database, action, actor, createResourceServices(context));
    return updateActionStatus(tx as unknown as Database, id, {
      status: "succeeded", executionResult: { entityType: execution.entityType, entityId: execution.entityId, result: execution.result },
    }, actor);
  });
}

function countByStatus(rows: Array<{ status: string }>) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
}

function formatStatusCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts);
  return entries.length > 0
    ? entries.map(([status, count]) => `${status}: ${count}`).join(", ")
    : "none";
}

function getContextRecord(context: unknown): Record<string, unknown> {
  return context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function getWorkflowPrompt(workflow: SendAssistantMessageInput["workflow"]) {
  switch (workflow) {
    case "project_health":
      return "Summarize project health, risks, blocked work, and next maintenance steps.";
    case "stale_tasks":
      return "Find stale or long-open tasks and suggest concrete follow-up actions.";
    case "failed_ti_runs":
      return "Triage failed or in-review Ti agent runs and suggest recovery actions.";
    case "schedule_maintenance":
      return "Review schedules for paused, stale, missed, or risky automation settings.";
    case "requirement_next_steps":
      return "Suggest the next useful steps for the current requirement.";
    case "personal_inbox_cleanup":
      return "Review personal/inbox style work and suggest cleanup actions.";
    default:
      return null;
  }
}

function staleTasks(tasksList: Array<Record<string, unknown>>) {
  const cutoffMs = Date.now() - 7 * 86_400_000;
  return tasksList
    .filter((row) => ["todo", "in_progress", "in_review"].includes(String(row.status)))
    .filter((row) => {
      const updatedAt = row.updatedAt ? new Date(String(row.updatedAt)).getTime() : 0;
      return Number.isFinite(updatedAt) && updatedAt < cutoffMs;
    });
}

function generateReadOnlyResponse(
  context: unknown,
  userMessage: string,
  workflow?: SendAssistantMessageInput["workflow"],
) {
  const root = getContextRecord(context);
  const current = getContextRecord(root.current);
  const projectState = getContextRecord(root.projectState);
  const retrieval = getContextRecord(root.retrieval);
  const tiAgent = getContextRecord(root.tiAgent);

  const project = getContextRecord(current.project);
  const requirement = getContextRecord(current.requirement);
  const task = getContextRecord(current.task);
  const schedule = getContextRecord(current.schedule);
  const requirementsList = asArray(projectState.requirements);
  const tasksList = asArray(projectState.tasks);
  const schedulesList = asArray(projectState.schedules);
  const documentsList = asArray(retrieval.documents);
  const memoriesList = asArray(retrieval.memories);
  const mcpToolsList = asArray(retrieval.mcpTools);
  const failedRuns = asArray(tiAgent.recentFailures);
  const stale = staleTasks(tasksList);

  const focus = [
    project.name ? `project "${project.name}"` : null,
    requirement.title ? `requirement "${requirement.title}"` : null,
    task.title ? `task "${task.title}"` : null,
    schedule.title ? `schedule "${schedule.title}"` : null,
  ].filter(Boolean).join(", ") || "the current workspace";

  const taskCounts = countByStatus(tasksList.map((row) => ({ status: String(row.status ?? "unknown") })));
  const requirementCounts = countByStatus(requirementsList.map((row) => ({ status: String(row.status ?? "unknown") })));
  const riskyTasks = tasksList
    .filter((row) => ["todo", "in_progress", "in_review"].includes(String(row.status)))
    .slice(0, 5)
    .map((row) => `- ${String(row.title ?? "Untitled task")} (${String(row.status ?? "unknown")}, ${String(row.priority ?? "unknown")})`);

  const sections = [
    `I reviewed ${focus} in read-only mode.`,
    workflow ? `Workflow: ${workflow}. ${getWorkflowPrompt(workflow)}` : `Question: ${truncate(userMessage, 800)}`,
    `Requirement status counts: ${formatStatusCounts(requirementCounts)}.`,
    `Task status counts: ${formatStatusCounts(taskCounts)}.`,
    `Schedules in context: ${schedulesList.length}. Relevant documents: ${documentsList.length}. Memories: ${memoriesList.length}. MCP tools visible: ${mcpToolsList.length}.`,
  ];

  if (failedRuns.length > 0) {
    sections.push(`Recent Ti run issues: ${failedRuns.length}. Review failed or in-review runs before enabling automatic maintenance.`);
  }

  if (workflow === "stale_tasks") {
    sections.push(
      stale.length > 0
        ? `Stale tasks found:\n${stale.slice(0, 6).map((row) => `- ${String(row.title ?? "Untitled task")} (${String(row.status ?? "unknown")})`).join("\n")}`
        : "No stale open tasks were found in the bounded context.",
    );
  }

  if (workflow === "schedule_maintenance") {
    const paused = schedulesList.filter((row) => String(row.status) === "paused").length;
    const inactive = schedulesList.filter((row) => !row.nextRunAt && String(row.status) === "active").length;
    sections.push(`Schedule maintenance: ${paused} paused schedules and ${inactive} active schedules without a next run were visible.`);
  }

  if (workflow === "requirement_next_steps" && requirement.title) {
    sections.push(`Requirement next step: review open tasks under "${String(requirement.title)}" and convert any ambiguous follow-up into an approved task proposal.`);
  }

  if (workflow === "failed_ti_runs" && failedRuns.length === 0) {
    sections.push("No failed or in-review Ti runs were visible in the bounded context.");
  }

  if (riskyTasks.length > 0) {
    sections.push(`Open work to inspect:\n${riskyTasks.join("\n")}`);
  }

  sections.push(workflow ? "No project data was changed. Any workflow actions are proposals and require approval." : "No project data was changed.");
  return sections.join("\n\n");
}

function workflowProposals(
  context: Record<string, unknown>,
  input: SendAssistantMessageInput,
): AssistantActionProposal[] {
  const current = getContextRecord(context.current);
  const projectState = getContextRecord(context.projectState);
  const tiAgent = getContextRecord(context.tiAgent);
  const project = getContextRecord(current.project);
  const requirement = getContextRecord(current.requirement);
  const task = getContextRecord(current.task);
  const tasksList = asArray(projectState.tasks);
  const failedRuns = asArray(tiAgent.recentFailures);
  const projectId = String(input.context.projectId ?? project.id ?? "");
  const requirementId = String(input.context.requirementId ?? requirement.id ?? task.requirementId ?? "");

  if (!input.workflow) return input.proposedActions;

  const proposals: AssistantActionProposal[] = [...input.proposedActions];
  if (input.workflow === "stale_tasks" && projectId && requirementId) {
    for (const stale of staleTasks(tasksList).slice(0, 3)) {
      proposals.push({
        actionType: "add_comment",
        payload: {
          taskId: String(stale.id),
          content: "Assistant maintenance suggestion: this task appears stale. Please confirm whether it should be resumed, reprioritized, or closed.",
        },
        preview: `Add stale-task follow-up comment to "${String(stale.title ?? "task")}".`,
      });
    }
  }

  if (input.workflow === "failed_ti_runs" && projectId && requirementId && failedRuns.length > 0) {
    proposals.push({
      actionType: "create_task",
      payload: {
        projectId,
        requirementId,
        title: "Triage failed Ti agent runs",
        description: failedRuns
          .slice(0, 5)
          .map((run) => `- Run ${String(run.id)}: ${String(run.errorMessage ?? run.outputSummary ?? "needs review")}`)
          .join("\n"),
        priority: "high",
      },
      preview: "Create a task to triage recent failed or in-review Ti agent runs.",
    });
  }

  if (input.workflow === "requirement_next_steps" && projectId && requirementId) {
    proposals.push({
      actionType: "create_task",
      payload: {
        projectId,
        requirementId,
        title: `Clarify next step for ${String(requirement.title ?? "requirement")}`.slice(0, 120),
        description: input.message,
        priority: "medium",
      },
      preview: "Create a requirement follow-up task from this assistant workflow.",
    });
  }

  if (input.workflow === "project_health" && projectId) {
    proposals.push({
      actionType: "draft_document",
      payload: {
        projectId,
        title: `Project health summary - ${new Date().toISOString().slice(0, 10)}`,
        content: generateReadOnlyResponse(context, input.message, input.workflow),
        summary: "Assistant-generated project health summary draft.",
        docType: "meeting",
        needsReview: true,
      },
      preview: "Create a reviewable project health summary document draft.",
    });
  }

  return proposals.slice(0, 8);
}

export async function sendReadOnlyMessage(
  db: Database,
  input: SendAssistantMessageInput,
  actor: Actor,
  identity?: VerifiedRequestContext,
) {
  if (!identity) throw new AuthorizationError();
  const conversation = input.conversationId
    ? await db.query.assistantConversations.findFirst({
      where: eq(assistantConversations.id, input.conversationId),
    })
    : await createConversation(db, {
      projectId: input.context.projectId ?? null,
      requirementId: input.context.requirementId ?? null,
      taskId: input.context.taskId ?? null,
      scheduleId: input.context.scheduleId ?? null,
      contextKind: input.context.contextKind,
      title: truncate(input.message, 120),
    }, actor);

  if (!conversation) throw new NotFoundError("Assistant conversation not found");

  const contextSnapshot = await buildAssistantContext(
    db,
    {
      ...input.context,
      conversationId: conversation.id,
      intent: input.context.intent ?? input.message,
    },
    actor,
    identity,
  ) as Record<string, unknown>;

  const userMessage = await createMessage(db, {
    conversationId: conversation.id,
    role: "user",
    content: input.message,
    contextSnapshot,
    metadata: { readOnly: true },
  }, actor);

  let model: ResolvedTiModel | null = null;
  let modelError: string | null = null;
  try {
    const modelCall = [db, { requestedProvider: input.requestedProvider, requestedModel: input.requestedModel, target: "chat" }, actor];
    await authorizeMetadataOperation(db, await getLiveRequestAuthority(db, identity), "ti", "resolveModel", modelCall);
    model = await resolveModel(db, modelCall[1] as Parameters<typeof resolveModel>[1], actor);
  } catch (err) {
    modelError = err instanceof Error ? err.message : "Ti model resolution failed";
  }

  const workflowPrompt = getWorkflowPrompt(input.workflow);
  let content = generateReadOnlyResponse(contextSnapshot, workflowPrompt ?? input.message, input.workflow);
  if (model && !modelError) {
    try {
      content = await generateModelResponse(model, contextSnapshot, input);
    } catch (err) {
      modelError = err instanceof Error ? err.message : "Ti model request failed";
    }
  }

  const assistantMessage = await createMessage(db, {
    conversationId: conversation.id,
    role: "assistant",
    content,
    provider: model?.actualProvider ?? null,
    model: model?.actualModel ?? null,
    metadata: {
      readOnly: true,
      workflow: input.workflow ?? null,
      tiBacked: modelError ? false : true,
      requestedProvider: model?.requestedProvider ?? input.requestedProvider ?? null,
      requestedModel: model?.requestedModel ?? input.requestedModel ?? null,
      actualProvider: model?.actualProvider ?? null,
      actualModel: model?.actualModel ?? null,
      fallbackReason: model?.fallbackReason ?? null,
      modelError,
      actionExecutionAllowed: false,
    },
  }, actor);

  const proposedActions = [];
  for (const proposal of workflowProposals(contextSnapshot, input)) {
    proposedActions.push(
      await createProposedAction(db, conversation.id, assistantMessage.id, proposal, actor),
    );
  }

  return {
    conversation,
    userMessage,
    assistantMessage,
    context: contextSnapshot,
    actions: proposedActions,
    model: model
      ? {
        requestedProvider: model.requestedProvider,
        requestedModel: model.requestedModel,
        actualProvider: model.actualProvider,
        actualModel: model.actualModel,
        fallbackReason: model.fallbackReason,
      }
      : null,
    modelError,
  };
}
