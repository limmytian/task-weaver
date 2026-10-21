import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { tiSandboxOperations, tiSandboxWorkspaces, tiAgentRuns, assistantConversations, type Database } from "@task-weaver/db";
import { PartnersMcpError } from "./partners-mcp";
import type { TiSandboxBinding } from "./ti-sandboxes";

const w = tiSandboxWorkspaces;
const o = tiSandboxOperations;
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/** Reconciliation starts exclusively from TW ownership tombstones, never from a provider-wide resource listing. */
export function createTiSandboxCleanup(db: Database, resolveBinding: (id: string) => Promise<TiSandboxBinding>) {
  let scanAfter: string | undefined;
  async function reconcileOrphans() {
    const rows = await db.select().from(w).where(and(ne(w.state, "deleted"), ne(w.state, "cleanup_pending"), scanAfter ? sql`${w.id} > ${scanAfter}` : undefined))
      .orderBy(asc(w.id)).limit(100);
    scanAfter = rows.length === 100 ? rows.at(-1)!.id : undefined;
    for (const row of rows) {
      const run = row.runId ? await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, row.runId) }) : null;
      const conversation = row.conversationId ? await db.query.assistantConversations.findFirst({ where: eq(assistantConversations.id, row.conversationId) }) : null;
      const binding = run?.authorization as { ownerId?: string; leaseGeneration?: number } | null;
      const orphan = row.runId ? !run || ["succeeded", "failed", "cancelled"].includes(run.status) || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date()
        || binding?.ownerId !== row.ownerId || binding?.leaseGeneration !== row.attempt
        : !conversation || conversation.createdBy !== row.ownerId || conversation.createdByType !== row.ownerType;
      if (orphan) await db.update(w).set({ state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date(), updatedAt: new Date() })
        .where(and(eq(w.id, row.id), eq(w.state, row.state)));
    }
  }
  return {
    async reconcileOrphans() { await reconcileOrphans(); },
    async runOnce() {
      const now = new Date();
      const leaseId = randomUUID();
      const row = await db.transaction(async tx => {
        const [selected] = await tx.select().from(w).where(and(ne(w.state, "deleted"),
          or(eq(w.state, "cleanup_pending"), lte(w.expiresAt, now)),
          or(isNull(w.nextCleanupAt), lte(w.nextCleanupAt, now)),
          or(isNull(w.cleanupLeaseExpiresAt), lte(w.cleanupLeaseExpiresAt, now))))
          .orderBy(asc(w.createdAt)).limit(1).for("update", { skipLocked: true });
        if (!selected) return null;
        const [claimed] = await tx.update(w).set({ state: "cleanup_pending", cleanupRequestedAt: selected.cleanupRequestedAt ?? now,
          cleanupLeaseId: leaseId, cleanupLeaseExpiresAt: new Date(Date.now() + 120_000), cleanupAttempts: selected.cleanupAttempts + 1, updatedAt: now })
          .where(eq(w.id, selected.id)).returning();
        return claimed!;
      });
      if (!row) return false;
      const fence = and(eq(w.id, row.id), eq(w.cleanupLeaseId, leaseId));
      const assertLease = async () => {
        const current = await db.query.tiSandboxWorkspaces.findFirst({ where: and(fence, sql`${w.cleanupLeaseExpiresAt} > now()`) });
        if (!current) throw new PartnersMcpError("CLEANUP_LEASE_LOST", true);
      };
      try {
        const binding = await resolveBinding(row.bindingId);
        if (binding.id !== row.bindingId || binding.tenantId !== row.tenantId || binding.projectId !== row.providerProjectId) throw new PartnersMcpError("BINDING_MISMATCH", false);
        let sessionId = row.sessionId;
        if (!sessionId) {
          // Exact idempotent recovery is safe only within the provider's documented deduplication window.
          if (Date.now() - row.createdAt.getTime() > 23 * 3600_000) throw new PartnersMcpError("SESSION_RECONCILIATION_EXPIRED", false);
          await assertLease();
          const session = await binding.adapter.invoke("session_create", { requestId: row.sessionRequestId, tenantId: row.tenantId, projectId: row.providerProjectId });
          sessionId = session.sessionId;
          await db.update(w).set({ sessionId, updatedAt: new Date() }).where(fence);
        }
        const operations = await db.query.tiSandboxOperations.findMany({ where: eq(o.workspaceId, row.id) });
        for (const operation of operations) {
          await assertLease();
          const jobId = operation.jobId;
          // Never resubmit an uncertain command during cleanup: a never-accepted command could start new side effects.
          // session_delete refuses busy workspaces; bounded jobs eventually terminate and cleanup retries deletion.
          if (!jobId) continue;
          await assertLease();
          const status = await binding.adapter.invoke("job_get", { jobId });
          if (status.sessionId !== sessionId) throw new PartnersMcpError("RESOURCE_MISMATCH", false);
          if (!terminal.has(status.state)) {
            await assertLease();
            await binding.adapter.invoke("job_cancel", { jobId, reason: "TW owned workspace cleanup" });
            const confirmed = await binding.adapter.invoke("job_get", { jobId });
            if (confirmed.sessionId !== sessionId || !terminal.has(confirmed.state)) throw new PartnersMcpError("CANCELLATION_PENDING", true);
          }
          await db.update(o).set({ state: "terminal", updatedAt: new Date() }).where(eq(o.id, operation.id));
        }
        await assertLease();
        const deleted = await binding.adapter.invoke("session_delete", { sessionId });
        if (deleted.state !== "deleted") throw new PartnersMcpError("DELETION_PENDING", true);
        await db.update(w).set({ state: "deleted", deletedAt: new Date(), cleanupLeaseId: null, cleanupLeaseExpiresAt: null,
          nextCleanupAt: null, lastErrorCode: null, updatedAt: new Date() }).where(fence);
      } catch (error) {
        const delay = Math.min(3600_000, 1000 * 2 ** Math.min(row.cleanupAttempts, 12));
        await db.update(w).set({ state: "cleanup_pending", lastErrorCode: error instanceof PartnersMcpError ? error.code : "CLEANUP_FAILED",
          nextCleanupAt: new Date(Date.now() + delay), cleanupLeaseId: null, cleanupLeaseExpiresAt: null, updatedAt: new Date() }).where(fence);
      }
      return true;
    },
    async metrics() {
      return db.select({ state: w.state, count: count(), oldestCreatedAt: sql<Date>`min(${w.createdAt})`,
        retries: sql<number>`coalesce(sum(${w.cleanupAttempts}), 0)::int` }).from(w).where(ne(w.state, "deleted")).groupBy(w.state);
    },
  };
}
