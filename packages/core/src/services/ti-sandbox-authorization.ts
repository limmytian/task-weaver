import { eq } from "drizzle-orm";
import { assistantConversations, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { getLiveRequestAuthority } from "./api-keys";
import { requireResource, requireScope } from "./resource-authorization";
import { liveTiRunAuthority } from "./ti-execution-authorization";

export type TiSandboxScope = {
  ownerId: string; ownerType: "human" | "agent"; projectId: string | null;
  conversationId: string | null; runId: string | null; attempt: number;
};

/** Scope is derived from live authenticated state, never from model arguments. */
export function createTiSandboxAuthority(db: Database, identity: VerifiedRequestContext,
  context: { conversationId: string; attempt: number } | { runId: string; workerId: string; leaseGeneration: number }) {
  return async (): Promise<TiSandboxScope> => {
    const live = await getLiveRequestAuthority(db, identity);
    if ("conversationId" in context) {
      if (live.bounds || live.actor.type !== "human" || !Number.isSafeInteger(context.attempt) || context.attempt < 1) throw new AuthorizationError();
      requireScope(live, { personalOwnerId: live.actor.id, personalOwnerType: "human" }, "resource.write");
      const conversation = await db.query.assistantConversations.findFirst({ where: eq(assistantConversations.id, context.conversationId) });
      if (!conversation || conversation.createdBy !== live.actor.id || conversation.createdByType !== live.actor.type) throw new NotFoundError("Conversation not found");
      if (conversation.projectId) await requireResource(db, live, "project", conversation.projectId, "execution.run");
      return { ownerId: live.actor.id, ownerType: live.actor.type, projectId: conversation.projectId,
        conversationId: conversation.id, runId: null, attempt: context.attempt };
    }
    const run = await liveTiRunAuthority(db, context.runId);
    if (identity.credential.kind !== "api_key" || identity.credential.id !== run.binding.executorCredentialId
      || live.actor.id !== run.binding.executorActorId || context.workerId !== run.binding.workerId
      || context.leaseGeneration !== run.binding.leaseGeneration) throw new AuthorizationError();
    return { ownerId: run.binding.ownerId, ownerType: "human", projectId: run.task.projectId,
      conversationId: null, runId: run.run.id, attempt: context.leaseGeneration };
  };
}
