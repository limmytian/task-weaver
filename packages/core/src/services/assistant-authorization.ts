import { lockIdentityLifecycle } from "./auth-security";
import { and, eq } from "drizzle-orm";
import { assistantActions, assistantConversations, tiAgentPolicies, activityLog, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type VerifiedRequestContext, type BuildAssistantContextInput, assistantPolicySchema, updateAssistantPolicySchema } from "@task-weaver/contracts";
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
  return {
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
      await conversation(db, id);
      return implementation.getConversation(db, id, await scope(db, {}));
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
      if (input.conversationId) await conversation(db, input.conversationId);
      return implementation.buildAssistantContext(db, input, actor, identity);
    },
    async sendReadOnlyMessage(db: Database, input: Parameters<typeof implementation.sendReadOnlyMessage>[1]) {
      await write(db);
      const actor = await scope(db, input.context);
      if (input.conversationId) await conversation(db, input.conversationId);
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
