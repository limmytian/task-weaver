import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, isNull, ne, type AnyColumn } from "drizzle-orm";
import { tiSandboxOperations, tiSandboxWorkspaces, type Database } from "@task-weaver/db";
import { AuthorizationError, ConflictError, ValidationError } from "@task-weaver/contracts";
import { createPartnersMcpAdapter, PartnersMcpError, partnersMcpInputs } from "./partners-mcp";
import type { TiSandboxScope } from "./ti-sandbox-authorization";

type Workspace = typeof tiSandboxWorkspaces.$inferSelect;
type Adapter = ReturnType<typeof createPartnersMcpAdapter>;
export type TiSandboxBinding = { id: string; tenantId: string; projectId: string; adapter: Adapter };
const w = tiSandboxWorkspaces;
const o = tiSandboxOperations;
const nullable = (column: AnyColumn, value: string | null) => value === null ? isNull(column) : eq(column, value);
function scopePredicate(scope: TiSandboxScope) {
  return and(eq(w.ownerId, scope.ownerId), eq(w.ownerType, scope.ownerType), nullable(w.projectId, scope.projectId),
    nullable(w.conversationId, scope.conversationId), nullable(w.runId, scope.runId), eq(w.attempt, scope.attempt));
}
function sameScope(row: Workspace, scope: TiSandboxScope) {
  return row.ownerId === scope.ownerId && row.ownerType === scope.ownerType && row.projectId === scope.projectId
    && row.conversationId === scope.conversationId && row.runId === scope.runId && row.attempt === scope.attempt;
}
const errorCode = (error: unknown) => error instanceof PartnersMcpError ? error.code : "OPERATION_UNKNOWN";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only an authenticated supervisor can construct this service. Public methods never accept provider resource IDs. */
export function createTiSandboxService(db: Database, authorize: () => Promise<TiSandboxScope>, binding: TiSandboxBinding) {
  async function owned(row: Workspace, active = true) {
    const scope = await authorize();
    const current = await db.query.tiSandboxWorkspaces.findFirst({ where: and(eq(w.id, row.id), scopePredicate(scope)) });
    if (!current || !sameScope(current, scope) || current.bindingId !== binding.id || current.tenantId !== binding.tenantId
      || current.providerProjectId !== binding.projectId) throw new AuthorizationError();
    if (active && (current.state !== "active" || current.cancelRequestedAt || current.cleanupRequestedAt || current.expiresAt <= new Date())) throw new AuthorizationError();
    return current;
  }
  async function workspace() {
    const scope = await authorize();
    let row = await db.query.tiSandboxWorkspaces.findFirst({ where: scopePredicate(scope) });
    if (!row) {
      row = await db.transaction(async tx => {
        const existing = await tx.query.tiSandboxWorkspaces.findFirst({ where: scopePredicate(scope) });
        if (existing) return existing;
        const [usage] = await tx.select({ total: count() }).from(w).where(and(eq(w.ownerId, scope.ownerId), eq(w.ownerType, scope.ownerType), ne(w.state, "deleted")));
        if (usage!.total >= 4) throw new ValidationError("Sandbox owner quota exceeded; pending cleanup counts toward quota");
        const [created] = await tx.insert(w).values({ ...scope, bindingId: binding.id, tenantId: binding.tenantId, providerProjectId: binding.projectId,
          expiresAt: new Date(Date.now() + 30 * 60_000) }).onConflictDoNothing().returning();
        return created ?? (await tx.query.tiSandboxWorkspaces.findFirst({ where: scopePredicate(scope) }))!;
      }, { isolationLevel: "serializable" });
    }
    if (!row) throw new ConflictError("Sandbox ownership changed", 0);
    await owned(row, false);
    if (row.expiresAt <= new Date() || row.cleanupRequestedAt || row.cancelRequestedAt) throw new AuthorizationError();
    if (row.state === "provisioning") {
      try {
        const session = await binding.adapter.invoke("session_create", { requestId: row.sessionRequestId, tenantId: row.tenantId, projectId: row.providerProjectId });
        // Record accepted infrastructure identity even if the user's authority was revoked in flight.
        // The independent cleanup worker needs this mapping; no result is exposed until authority is rechecked.
        const [updated] = await db.update(w).set({ sessionId: session.sessionId, state: "active", updatedAt: new Date() })
          .where(and(eq(w.id, row.id), eq(w.state, "provisioning"), isNull(w.cleanupRequestedAt))).returning();
        if (!updated) {
          const concurrent = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, row.id) });
          if (concurrent?.state === "active" && concurrent.sessionId === session.sessionId && !concurrent.cleanupRequestedAt) return owned(concurrent);
          await db.update(w).set({ sessionId: session.sessionId, state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date(), updatedAt: new Date() }).where(eq(w.id, row.id));
          throw new AuthorizationError();
        }
        row = updated;
      } catch (error) {
        await db.update(w).set({ lastErrorCode: errorCode(error), updatedAt: new Date() }).where(eq(w.id, row.id));
        throw error;
      }
    }
    return owned(row);
  }
  async function operation(logicalKey: string, tool: "bash_exec" | "file_ops", input: Record<string, unknown>) {
    if (!logicalKey || logicalKey.length > 200) throw new ValidationError("Invalid sandbox operation identity");
    const row = await workspace();
    if (!row.sessionId) throw new PartnersMcpError("SESSION_UNKNOWN", false);
    const normalized = partnersMcpInputs[tool].parse({ ...input, sessionId: row.sessionId, requestId: randomUUID() });
    const { requestId: _requestId, ...parameters } = normalized as Record<string, unknown>;
    const argumentHash = hash(parameters);
    const [created] = await db.insert(o).values({ workspaceId: row.id, logicalKey, tool, arguments: parameters, argumentHash }).onConflictDoNothing().returning();
    const receipt = created ?? await db.query.tiSandboxOperations.findFirst({ where: and(eq(o.workspaceId, row.id), eq(o.logicalKey, logicalKey)) });
    if (!receipt || receipt.tool !== tool || receipt.argumentHash !== argumentHash) throw new ConflictError("Sandbox operation identity cannot be reused with different input", 0);
    await owned(row);
    if (!created) {
      if (receipt.result) return receipt.result;
      throw new PartnersMcpError("OPERATION_PENDING_RECONCILIATION", false, { ...(receipt.jobId ? { jobId: receipt.jobId } : {}) });
    }
    try {
      const result = tool === "bash_exec"
        ? await binding.adapter.invoke("bash_exec", { ...receipt.arguments, requestId: receipt.requestId } as Parameters<Adapter["invoke"]>[1] & { sessionId: string; command: string; requestId: string })
        : await binding.adapter.invoke("file_ops", { ...receipt.arguments, requestId: receipt.requestId } as { sessionId: string; action: "write"; path: string; content: string; requestId: string; createOnly: true });
      await db.update(o).set({ state: tool === "bash_exec" ? "accepted" : "terminal", jobId: "jobId" in result ? result.jobId : null,
        result, updatedAt: new Date() }).where(eq(o.id, receipt.id));
      await owned(row);
      return result;
    } catch (error) {
      await db.update(o).set({ state: "uncertain", lastErrorCode: errorCode(error), updatedAt: new Date() }).where(and(eq(o.id, receipt.id), eq(o.state, "pending")));
      throw error;
    }
  }
  return {
    async execute(logicalKey: string, input: { command: string; cwd?: string; timeoutSeconds?: number }) {
      return operation(logicalKey, "bash_exec", input);
    },
    async write(logicalKey: string, input: { path: string; content: string; createOnly?: boolean; expectedHash?: string }) {
      return operation(logicalKey, "file_ops", { ...input, action: "write" });
    },
    async read(input: { path: string; offsetBytes?: number; maxBytes?: number }) {
      const row = await workspace();
      const result = await binding.adapter.invoke("file_ops", { ...input, action: "read", sessionId: row.sessionId! });
      await owned(row); return result;
    },
    async getJob(logicalKey: string, input: { cursor?: string; maxOutputBytes?: number } = {}) {
      const row = await workspace();
      const receipt = await db.query.tiSandboxOperations.findFirst({ where: and(eq(o.workspaceId, row.id), eq(o.logicalKey, logicalKey)) });
      if (!receipt?.jobId) throw new AuthorizationError();
      const result = await binding.adapter.invoke("job_get", { ...input, jobId: receipt.jobId });
      if (result.sessionId !== row.sessionId) throw new PartnersMcpError("RESOURCE_MISMATCH", false);
      await owned(row);
      if (["succeeded", "failed", "cancelled", "timed_out"].includes(result.state)) await db.update(o).set({ state: "terminal", updatedAt: new Date() }).where(eq(o.id, receipt.id));
      return result;
    },
    async requestCleanup(cancel = false) {
      const scope = await authorize();
      const row = await db.query.tiSandboxWorkspaces.findFirst({ where: scopePredicate(scope) });
      if (!row) return;
      await owned(row, false);
      await db.update(w).set({ state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date(),
        ...(cancel ? { cancelRequestedAt: new Date() } : {}), updatedAt: new Date() }).where(and(eq(w.id, row.id), ne(w.state, "deleted")));
    },
  };
}
