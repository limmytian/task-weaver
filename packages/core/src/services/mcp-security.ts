import { McpInvocationBusy } from "./mcp-invocation-budget";
import { createHash } from "node:crypto";
import { and, eq, inArray, lt, desc } from "drizzle-orm";
import { type Database, authActors, projectMemberships, apiKeys, mcpInvocationAudits, mcpInvocationPolicies, mcpInvocationApprovals } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, requireScope, type ResourceScope } from "./resource-authorization";
import { lockIdentityLifecycle, auditIdentity } from "./auth-security";

export class McpApprovalRequired extends Error {
  constructor(readonly approvalId: string) { super("Explicit approval is required for this operation."); }
}
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ":" + canonical(child)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function mcpScopeKey(scope: ResourceScope) {
  if (scope.projectId) return "project:" + scope.projectId;
  if (scope.personalOwnerId) return "personal:" + scope.personalOwnerId;
  return "global";
}
export function mcpScopeFromKey(key: string): ResourceScope {
  if (key === "global") return {};
  if (/^project:[0-9a-f-]{36}$/.test(key)) return { projectId: key.slice(8) };
  if (/^personal:[0-9a-f-]{36}$/.test(key)) return { personalOwnerId: key.slice(9), personalOwnerType: "human" };
  throw new AuthorizationError();
}
export async function mcpPolicy(db: Database, scopeKey: string, toolId: string) {
  const rows = await db.select().from(mcpInvocationPolicies).where(and(eq(mcpInvocationPolicies.scopeKey, scopeKey), inArray(mcpInvocationPolicies.toolId, [toolId, "*"])));
  return { mode: rows.some(row => row.mode === "deny") ? "deny" : rows.some(row => row.mode === "approval") ? "approval" : "allow", versions: rows.map(row => row.id + ":" + row.version).sort() };
}

/** Serialized consumption prevents replay; the operation must independently reauthorize its resources. */
export async function requireMcpApproval(db: Database, identity: VerifiedRequestContext, scope: ResourceScope, toolId: string, operation: unknown, approvalId?: string, consume = true, allowConsumed = false) {
  const result = await db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database;
    const authority = await resourceAuthority(tx, identity);
    const scopeKey = mcpScopeKey(scope);
    const policy = await mcpPolicy(database, scopeKey, toolId);
    if (policy.mode === "deny") throw new AuthorizationError();
    if (policy.mode !== "approval") {
      if (approvalId) throw new AuthorizationError();
      return null;
    }
    const [key] = identity.credential.kind === "api_key" ? await tx.select({ grantVersion: apiKeys.grantVersion }).from(apiKeys).where(eq(apiKeys.id, identity.credential.id)) : [];
    const [principalRevision] = await tx.select({ updatedAt: authActors.updatedAt }).from(authActors).where(eq(authActors.id, authority.actor.id));
    const membershipRevisions = await tx.select({ id: projectMemberships.id, updatedAt: projectMemberships.updatedAt, removedAt: projectMemberships.removedAt }).from(projectMemberships).where(eq(projectMemberships.actorId, authority.actor.id)).orderBy(projectMemberships.id);
    const operationHash = hash(operation), authorityHash = hash({ authority, grantVersion: key?.grantVersion, principalRevision, membershipRevisions });
    if (!approvalId) {
      const [request] = await tx.insert(mcpInvocationApprovals).values({ actorId: authority.actor.id, credentialId: identity.credential.id, scopeKey, toolId, operationHash, authorityHash, policyVersions: policy.versions, expiresAt: new Date(Date.now() + 10 * 60_000) }).returning();
      return request!.id;
    }
    const [request] = await tx.select().from(mcpInvocationApprovals).where(eq(mcpInvocationApprovals.id, approvalId)).for("update");
    if (!request || request.actorId !== authority.actor.id || request.credentialId !== identity.credential.id || request.scopeKey !== scopeKey || request.toolId !== toolId || request.operationHash !== operationHash || request.authorityHash !== authorityHash || canonical(request.policyVersions) !== canonical(policy.versions) || !request.approvedBy || (allowConsumed ? !request.usedAt : request.usedAt) || request.expiresAt <= new Date()) throw new AuthorizationError();
    // Approval authority is live too; a removed or disabled approver cannot authorize execution.
    if (!request.approvedCredentialId || !request.approvedCredentialKind) throw new AuthorizationError();
    const { getBoundCredentialAuthority } = await import("./api-keys");
    const approver = await getBoundCredentialAuthority(database, { actorId: request.approvedBy, credentialId: request.approvedCredentialId, credentialKind: request.approvedCredentialKind });
    if (approver.actor.type !== "human") throw new AuthorizationError();
    requireScope(approver, scope, "mcp.manage");
    if (consume) await tx.update(mcpInvocationApprovals).set({ usedAt: new Date() }).where(eq(mcpInvocationApprovals.id, request.id));
    return null;
  });
  if (result) throw new McpApprovalRequired(result);
}

export async function approveMcpInvocation(db: Database, identity: VerifiedRequestContext, id: string) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    const [request] = await tx.select().from(mcpInvocationApprovals).where(eq(mcpInvocationApprovals.id, id)).for("update");
    if (!request) throw new NotFoundError("Resource not found");
    if (authority.actor.type !== "human" || authority.bounds) throw new AuthorizationError();
    requireScope(authority, mcpScopeFromKey(request.scopeKey), "mcp.manage");
    if (request.usedAt || request.expiresAt <= new Date()) throw new AuthorizationError();
    await tx.update(mcpInvocationApprovals).set({ approvedBy: authority.actor.id, approvedCredentialId: identity.credential.id, approvedCredentialKind: identity.credential.kind }).where(eq(mcpInvocationApprovals.id, id));
    await auditIdentity(tx, "mcp.approved", authority.actor.id, request.actorId, id);
    return { id, approved: true };
  });
}
export async function setMcpInvocationPolicy(db: Database, identity: VerifiedRequestContext, scope: ResourceScope, toolId: string, mode: "allow" | "approval" | "deny") {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    if (authority.actor.type !== "human" || authority.bounds) throw new AuthorizationError();
    requireScope(authority, scope, "mcp.manage");
    const scopeKey = mcpScopeKey(scope);
    const [existing] = await tx.select().from(mcpInvocationPolicies).where(and(eq(mcpInvocationPolicies.scopeKey, scopeKey), eq(mcpInvocationPolicies.toolId, toolId)));
    const [policy] = existing ? await tx.update(mcpInvocationPolicies).set({ mode, version: existing.version + 1, updatedAt: new Date() }).where(eq(mcpInvocationPolicies.id, existing.id)).returning() : await tx.insert(mcpInvocationPolicies).values({ scopeKey, toolId, mode }).returning();
    await auditIdentity(tx, "mcp.policy_changed", authority.actor.id, authority.actor.id, policy!.id, { scopeKey, toolId, mode, version: policy!.version });
    return policy!;
  });
}
export async function listMcpInvocationAudits(db: Database, identity: VerifiedRequestContext, scope: ResourceScope, limit = 20, offset = 0) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    requireScope(authority, scope, scope.personalOwnerId ? "mcp.manage" : "audit.read");
    return tx.select().from(mcpInvocationAudits).where(eq(mcpInvocationAudits.scopeKey, mcpScopeKey(scope))).orderBy(desc(mcpInvocationAudits.createdAt), mcpInvocationAudits.id).limit(Math.min(limit, 100)).offset(offset);
  });
}
export async function recordMcpInvocationAudit(db: Database, identity: VerifiedRequestContext, scope: ResourceScope, serverId: string, toolId: string, start: number, error?: unknown, isError = false, reference: Record<string, string | number | boolean> = {}) {
  const errorCode = error instanceof McpInvocationBusy ? "busy" : typeof error === "string" && ["read_only", "validation_error"].includes(error) ? error : error instanceof McpApprovalRequired ? "approval_required" : error instanceof AuthorizationError ? "permission_denied" : error instanceof NotFoundError ? "not_found" : error ? "invocation_failed" : isError ? "upstream_error" : null;
  const [audit] = await db.insert(mcpInvocationAudits).values({ actorId: identity.actor.id, credentialId: identity.credential.id, scopeKey: mcpScopeKey(scope), serverId, toolId, durationMs: Math.max(0, Date.now() - start), outcome: errorCode ? "error" : "success", errorCode }).returning({ id: mcpInvocationAudits.id });
  const delegation = identity.credential.kind === "delegation" ? identity.credential.delegation : undefined;
  if (delegation || Object.keys(reference).length) {
    await auditIdentity(db, delegation ? "delegation.capability_invocation" : "capability.operation", identity.actor.id, identity.actor.id, identity.credential.id, {
      ...reference, capabilityEvidenceVersion: 1, credentialId: identity.credential.id, scopeKey: mcpScopeKey(scope), attribution: delegation ? "run" : "credential",
      ...(delegation ? { runId: delegation.runId, projectId: delegation.projectId, requirementId: delegation.requirementId } : {}),
      invocationAuditId: audit!.id, evidenceSource: error ? "api_attempt" : "api", capabilityOutcome: errorCode ?? "returned",
    });
  }
  return audit!;
}
/** Operators run scoped cleanup explicitly; no user payload is ever retained. */
export async function cleanupMcpInvocationHistory(db: Database, identity: VerifiedRequestContext, scope: ResourceScope) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    requireScope(authority, scope, "mcp.manage");
    const scopeKey = mcpScopeKey(scope);
    await tx.delete(mcpInvocationAudits).where(and(eq(mcpInvocationAudits.scopeKey, scopeKey), lt(mcpInvocationAudits.createdAt, new Date(Date.now() - 30 * 86_400_000))));
    await tx.delete(mcpInvocationApprovals).where(and(eq(mcpInvocationApprovals.scopeKey, scopeKey), lt(mcpInvocationApprovals.expiresAt, new Date())));
    return { cleaned: true };
  });
}

export async function configureMcpToolAuthorization(db: Database, identity: VerifiedRequestContext, id: string, input: { readOnly: boolean; targetProjectArgument: string | null }) {
  const { mcpTools } = await import("@task-weaver/db");
  const { requireMcpServer } = await import("./mcp-authorization");
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    const [tool] = await tx.select().from(mcpTools).where(eq(mcpTools.id, id));
    if (!tool) throw new NotFoundError("Resource not found");
    await requireMcpServer(tx as unknown as Database, authority, identity, tool.serverId, "mcp.manage");
    const [updated] = await tx.update(mcpTools).set(input).where(eq(mcpTools.id, id)).returning();
    await auditIdentity(tx, "mcp.tool_authorization_changed", authority.actor.id, authority.actor.id, id);
    return updated!;
  });
}

export async function getMcpInvocationApproval(db: Database, identity: VerifiedRequestContext, id: string) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    const [request] = await tx.select().from(mcpInvocationApprovals).where(eq(mcpInvocationApprovals.id, id));
    if (!request) throw new NotFoundError("Resource not found");
    requireScope(authority, mcpScopeFromKey(request.scopeKey), "mcp.manage");
    return request;
  });
}
