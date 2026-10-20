import { resolveHostedMcpRuntime } from "./mcp-hosted-runtime";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { type Database, mcpServers, mcpTools, authActors } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type AuthorizationPermission, type VerifiedRequestContext } from "@task-weaver/contracts";
import { requireResource, resourcePredicate, type ResourceAuthority } from "./resource-authorization";

export function mcpServerPredicate(authority: ResourceAuthority, context: VerifiedRequestContext, permission: AuthorizationPermission = "resource.read") {
  return and(resourcePredicate(authority, { ...mcpServers, createdBy: mcpServers.registeredBy }, permission),
    isNotNull(mcpServers.registeredBy),
    sql`EXISTS (SELECT 1 FROM ${authActors} WHERE ${authActors.id}::text = ${mcpServers.registeredBy})`,
    or(sql`${mcpServers.transport} <> 'stdio'`, and(
      eq(mcpServers.registeredBy, authority.actor.id),
      eq(mcpServers.registeredCredentialId, credentialBinding(context)),
    )),
  )!;
}

export function credentialBinding(context: VerifiedRequestContext) {
  return context.credential.kind + ":" + context.credential.id;
}

export async function requireMcpServer(db: Database, authority: ResourceAuthority, context: VerifiedRequestContext, id: string, permission: AuthorizationPermission = "resource.read") {
  await requireResource(db, authority, "mcp", id, permission);
  const [server] = await db.select().from(mcpServers).where(and(eq(mcpServers.id, id), mcpServerPredicate(authority, context)));
  if (!server) throw new NotFoundError("Resource not found");
  if (permission === "mcp.invoke" && server.transport === "hosted-stdio") resolveHostedMcpRuntime(server);
  return server;
}

export function requireLocalHost(server: typeof mcpServers.$inferSelect, context: VerifiedRequestContext) {
  if (server.transport !== "stdio" || server.registeredBy !== context.actor.id
    || server.registeredCredentialId !== credentialBinding(context)) throw new AuthorizationError();
}

/** Tool discovery and invocation share live availability and credential scope. */
export function mcpInvocationPredicate(authority: ResourceAuthority, context: VerifiedRequestContext) {
  return and(mcpServerPredicate(authority, context, "mcp.invoke"), eq(mcpServers.active, true),
    eq(mcpServers.status, "connected"), or(sql`${mcpServers.expiresAt} IS NULL`, sql`${mcpServers.expiresAt} > now()`))!;
}

export async function requireMcpToolTarget(db: Database, authority: ResourceAuthority, server: typeof mcpServers.$inferSelect, tool: { readOnly: boolean; targetProjectArgument: string | null }, args?: Record<string, unknown>) {
  if (server.readOnly && !tool.readOnly) throw new AuthorizationError();
  if (tool.targetProjectArgument) {
    const projectId = args?.[tool.targetProjectArgument];
    if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/.test(projectId)) throw new AuthorizationError();
    return requireResource(db, authority, "project", projectId, "mcp.invoke");
  }
  return { projectId: server.projectId, personalOwnerId: server.personalOwnerId, personalOwnerType: server.personalOwnerType };
}

/** Applied in SQL before limits so an unauthorized tool cannot consume a result slot. */
export function mcpToolInvocationPredicate(authority: ResourceAuthority) {
  const projectIds = authority.grants.flatMap(grant => grant.scope === "project" && grant.permissions.includes("mcp.invoke") ? [grant.projectId] : []);
  const target = projectIds.length ? or(...projectIds.map(projectId => sql`NOT EXISTS (
    SELECT 1 FROM mcp_invocation_policies p WHERE p.scope_key = ${"project:" + projectId}
    AND p.tool_id IN ('*', ${mcpTools.id}::text) AND p.mode = 'deny'
  )`))! : sql`false`;
  return and(
    sql`EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = ${mcpTools.serverId} AND (s.read_only = false OR ${mcpTools.readOnly} = true)
      AND (${mcpTools.targetProjectArgument} IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM mcp_invocation_policies p WHERE p.scope_key = COALESCE('project:' || s.project_id::text, 'personal:' || s.personal_owner_id, 'global')
        AND p.tool_id IN ('*', ${mcpTools.id}::text) AND p.mode = 'deny'))
    )`,
    or(sql`${mcpTools.targetProjectArgument} IS NULL`, target),
  )!;
}
