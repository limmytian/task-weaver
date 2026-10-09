import { authorizeAssistantReadReference, type AssistantReadReference } from "./assistant-read-tools";
import { assistantDeletedReference } from "./assistant-assets";
import { lockIdentityLifecycle } from "./auth-security";
import { and, eq, sql } from "drizzle-orm";
import { assistantActions, assistantMessages, assistantConversations, tiAgentPolicies, activityLog, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, ValidationError, ConflictError, type VerifiedRequestContext, type BuildAssistantContextInput, assistantPolicySchema, updateAssistantPolicySchema, getAssistantMessageResultSchema } from "@task-weaver/contracts";
import { resourceAuthority, requireResource, requireScope } from "./resource-authorization";
import { createResourceServices } from "./resource-services";
import * as implementation from "./assistant";

/** Every entry point revalidates credentials and uses the verified account identity. */
export function createAssistantService(identity: VerifiedRequestContext) {
  async function authority(db: Database) {
    const live = await resourceAuthority(db, identity);
    if (live.bounds || live.actor.type !== "human") throw new AuthorizationError();
    requireScope(live, { personalOwnerId: live.actor.id, personalOwnerType: "human" }, "resource.read");
    return live;
  }
  async function scope(db: Database, input: Partial<BuildAssistantContextInput>) {
    const live = await authority(db);
    for (const [kind, id] of [["project", input.projectId], ["requirement", input.requirementId], ["task", input.taskId]] as const) {
      if (id) await requireResource(db, live, kind, id);
    }
    if (input.scheduleId) await createResourceServices(identity).scheduleService.getSchedule(db, input.scheduleId);
    return { id: live.actor.id, type: live.actor.type };
  }
  async function conversation(db: Database, id: string) {
    const live = await authority(db);
    const row = await db.query.assistantConversations.findFirst({ where: and(
      eq(assistantConversations.id, id), eq(assistantConversations.createdBy, live.actor.id),
      eq(assistantConversations.createdByType, live.actor.type),
    ) });
    if (!row) throw new NotFoundError("Assistant conversation not found");
    await scope(db, { projectId: row.projectId ?? undefined, requirementId: row.requirementId ?? undefined,
      taskId: row.taskId ?? undefined, scheduleId: row.scheduleId ?? undefined });
    return row;
  }
  async function history(db: Database, id: string) {
    await conversation(db, id);
    const actor = await scope(db, {});
    const result = await implementation.getConversation(db, id, actor);
    const live = await authority(db);
    const services = createResourceServices(identity);
    const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
    for (const message of result.messages) {
      const snapshot = record(message.contextSnapshot);
      for (const reference of Array.isArray(snapshot.toolReads) ? snapshot.toolReads : []) {
        if (!await assistantDeletedReference(db, result.actions, reference.kind, reference.id))
          await authorizeAssistantReadReference(db, identity, reference as AssistantReadReference);
      }
      const current = record(snapshot.current);
      const workspace = record(snapshot.workspace);
      for (const row of Array.isArray(workspace.projects) ? workspace.projects : []) {
        if (row.id) await requireResource(db, live, "project", row.id);
      }
      const state = record(snapshot.projectState);
      const retrieval = record(snapshot.retrieval);
      for (const kind of ["project", "requirement", "task"] as const) {
        if (current[kind]?.id) await requireResource(db, live, kind, current[kind].id);
      }
      for (const [kind, rows] of [["requirement", state.requirements], ["task", state.tasks], ["document", retrieval.documents], ["memory", retrieval.memories]] as const) {
        for (const row of Array.isArray(rows) ? rows : []) if (row.id && !await assistantDeletedReference(db, result.actions, kind, row.id)) await requireResource(db, live, kind, row.id);
      }
      for (const row of Array.isArray(state.schedules) ? state.schedules : []) await services.scheduleService.getSchedule(db, row.id);
      if (current.schedule?.id) await services.scheduleService.getSchedule(db, current.schedule.id);
      for (const row of Array.isArray(retrieval.mcpTools) ? retrieval.mcpTools : []) {
        if (!await assistantDeletedReference(db, result.actions, "mcp", row.serverId)) await requireResource(db, live, "mcp", row.serverId);
      }
    }
    for (const action of result.actions) {
      const execution = record(action.executionResult);
      if (["project", "requirement", "task", "document", "memory", "package", "mcp"].includes(execution.entityType) && execution.entityId
        && !await assistantDeletedReference(db, result.actions, execution.entityType, execution.entityId))
        await authorizeAssistantReadReference(db, identity, { kind: execution.entityType, id: execution.entityId });
      if (execution.entityType === "schedule") await services.scheduleService.getSchedule(db, execution.entityId);
      if (execution.entityType === "ti_agent_run") await services.tiAgentService.getRun(db, execution.entityId);
    }
    return result;
  }
  async function matchingConversation(db: Database, id: string, input: BuildAssistantContextInput) {
    const row = await conversation(db, id);
    for (const field of ["projectId", "requirementId", "taskId", "scheduleId"] as const) {
      if ((input[field] ?? null) !== row[field]) throw new AuthorizationError();
    }
    await history(db, id);
  }
  async function write(db: Database) {
    const live = await authority(db);
    requireScope(live, { personalOwnerId: live.actor.id, personalOwnerType: "human" }, "resource.write");
  }
  async function action(db: Database, id: string) {
    const row = await db.query.assistantActions.findFirst({ where: eq(assistantActions.id, id) });
    if (!row) throw new NotFoundError("Assistant action not found");
    await conversation(db, row.conversationId);
    return row;
  }
  async function messageResult(db: Database, input: { requestId: string }) {
    const { requestId } = getAssistantMessageResultSchema.parse(input);
    const actor = await scope(db, {});
    const [match] = await db.select({ id: assistantMessages.id, conversationId: assistantMessages.conversationId })
      .from(assistantMessages).innerJoin(assistantConversations, eq(assistantMessages.conversationId, assistantConversations.id))
      .where(and(eq(assistantMessages.role, "user"), eq(assistantConversations.createdBy, actor.id),
        eq(assistantConversations.createdByType, actor.type), sql`${assistantMessages.metadata}->>'requestId' = ${requestId}`)).limit(1);
    if (!match) return { status: "not_found" as const, result: null, progress: null };
    const data = await history(db, match.conversationId);
    const userMessage = data.messages.find(message => message.id === match.id)!;
    const metadata = userMessage.metadata as Record<string, unknown> | null;
    const assistantMessage = data.messages.find(message => message.role === "assistant"
      && (message.metadata as Record<string, unknown> | null)?.responseTo === userMessage.id);
    if (!assistantMessage || metadata?.processing === "running") return { status: metadata?.processing === "failed" ? "failed" as const : "running" as const, result: null, progress: { actions: data.actions.filter(action => action.messageId === userMessage.id) } };
    return { status: "completed" as const, progress: null, result: { conversation: data.conversation, userMessage, assistantMessage,
      actions: data.actions.filter(action => action.messageId === userMessage.id || action.messageId === assistantMessage.id) } };
  }
  return {
    getMessageResult: messageResult,
    async getPolicy(db: Database) {
      const actor = await scope(db, {});
      const row = await db.query.tiAgentPolicies.findFirst({ where: and(eq(tiAgentPolicies.ownerId, actor.id), eq(tiAgentPolicies.ownerType, "human")) });
      const known = assistantPolicySchema.shape.assistantActionAllowlist.element;
      return {
        assistantAutoEnabled: row?.assistantAutoEnabled ?? false,
        assistantAutoMode: row?.assistantAutoMode ?? "disabled" as const,
        assistantActionAllowlist: (row?.assistantActionAllowlist ?? []).filter(value => known.safeParse(value).success),
        assistantDailyActionLimit: row?.assistantDailyActionLimit ?? 10,
        assistantRunTimeoutSeconds: row?.assistantRunTimeoutSeconds ?? 300,
        assistantDefaultMaxRetries: row?.assistantDefaultMaxRetries ?? 0,
        assistantUncertainToReview: row?.assistantUncertainToReview ?? true,
        unsupportedActions: (row?.assistantActionAllowlist ?? []).filter(value => !known.safeParse(value).success),
      };
    },
    async updatePolicy(db: Database, input: Parameters<typeof updateAssistantPolicySchema.parse>[0]) {
      const patch = updateAssistantPolicySchema.parse(input);
      await write(db);
      const actor = await scope(db, {});
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        await write(tx as unknown as Database);
        const [row] = await tx.insert(tiAgentPolicies).values({ ownerId: actor.id, ownerType: "human", ...patch })
          .onConflictDoUpdate({ target: [tiAgentPolicies.ownerId, tiAgentPolicies.ownerType], set: { ...patch, updatedAt: new Date() } }).returning();
        await tx.insert(activityLog).values({ entityType: "ti_agent_policy", entityId: row!.id, action: "assistant_policy_updated", actorId: actor.id, actorType: "human", metadata: { fields: Object.keys(patch) } });
        return { saved: true };
      });
    },
    async listConversations(db: Database, input: Parameters<typeof implementation.listConversations>[1]) {
      const actor = await scope(db, { ...input, projectId: input.projectId ?? undefined,
        requirementId: input.requirementId ?? undefined, taskId: input.taskId ?? undefined, scheduleId: input.scheduleId ?? undefined });
      const rows = await implementation.listConversations(db, input, actor);
      const visible = [];
      for (const row of rows) {
        try { await conversation(db, row.id); visible.push(row); }
        catch (error) { if (!(error instanceof NotFoundError || error instanceof AuthorizationError)) throw error; }
      }
      return visible;
    },
    async getConversation(db: Database, id: string) {
      return history(db, id);
    },
    async renameConversation(db: Database, input: Parameters<typeof implementation.renameConversation>[1]) {
      await write(db);
      await conversation(db, input.id);
      return implementation.renameConversation(db, input, await scope(db, {}));
    },
    async deleteConversation(db: Database, id: string) {
      await write(db);
      await conversation(db, id);
      return implementation.deleteConversation(db, id, await scope(db, {}));
    },
    async buildAssistantContext(db: Database, input: BuildAssistantContextInput) {
      const actor = await scope(db, input);
      if (input.conversationId) await matchingConversation(db, input.conversationId, input);
      return implementation.buildAssistantContext(db, input, actor, identity);
    },
    async sendReadOnlyMessage(db: Database, input: Parameters<typeof implementation.sendReadOnlyMessage>[1]) {
      await write(db);
      const actor = await scope(db, input.context);
      if (input.conversationId) await matchingConversation(db, input.conversationId, input.context);
      if (input.requestId) {
        const previous = await db.query.assistantMessages.findFirst({ where: and(eq(assistantMessages.role, "user"),
          eq(assistantMessages.createdBy, actor.id), eq(assistantMessages.createdByType, actor.type),
          sql`${assistantMessages.metadata}->>'requestId' = ${input.requestId}`) });
        if (previous) {
          await matchingConversation(db, previous.conversationId, input.context);
          const fingerprint = previous.metadata?.requestFingerprint;
          if (previous.content !== input.message || (fingerprint && fingerprint !== implementation.assistantRequestFingerprint(input)))
            throw new ValidationError("A message request ID cannot be reused for different input");
          const existing = await messageResult(db, { requestId: input.requestId });
          if (existing.status === "completed" && existing.result) return { ...existing.result,
            context: existing.result.userMessage.contextSnapshot ?? {}, model: null, modelError: null };
          throw new ConflictError("The original request already exists; query its result instead of resubmitting", 0);
        }
      }
      return implementation.sendReadOnlyMessage(db, input, actor, identity);
    },
    async executeApprovedAction(db: Database, id: string) {
      await write(db);
      await action(db, id);
      return implementation.executeApprovedAction(db, id, await scope(db, {}), identity);
    },
    async updateActionStatus(db: Database, id: string, input: Parameters<typeof implementation.updateActionStatus>[2]) {
      await write(db);
      const row = await action(db, id);
      if (!["proposed", "approved"].includes(row.status) || !["approved", "rejected"].includes(input.status)
        || input.executionResult || input.activityLogId || input.errorMessage) throw new AuthorizationError();
      return implementation.updateActionStatus(db, id, { status: input.status }, await scope(db, {}));
    },
  };
}
