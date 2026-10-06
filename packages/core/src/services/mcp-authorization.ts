import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { type Database, mcpServers, authActors } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type AuthorizationPermission, type VerifiedRequestContext } from "@task-weaver/contracts";
import { requireResource, resourcePredicate, type ResourceAuthority } from "./resource-authorization";

export function mcpServerPredicate(authority: ResourceAuthority, context: VerifiedRequestContext) {
  return and(resourcePredicate(authority, { ...mcpServers, createdBy: mcpServers.registeredBy }),
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
  return server;
}

export function requireLocalHost(server: typeof mcpServers.$inferSelect, context: VerifiedRequestContext) {
  if (server.transport !== "stdio" || server.registeredBy !== context.actor.id
    || server.registeredCredentialId !== credentialBinding(context)) throw new AuthorizationError();
}
