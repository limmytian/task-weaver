import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { type Database, repositories, authActors } from "@task-weaver/db";
import { NotFoundError } from "@task-weaver/contracts";
import { canAccessResource, type ResourceAuthority } from "./resource-authorization";

/** Catalog visibility is independent of the projects which link a repository. */
export function repositoryPredicate(authority: ResourceAuthority): SQL {
  const scopes: SQL[] = [];
  if (canAccessResource(authority, {}, "resource.read"))
    scopes.push(and(eq(repositories.visibility, "instance"), isNull(repositories.ownerId), isNull(repositories.ownerType))!);
  const owners = authority.grants.flatMap(grant => grant.scope === "personal" && grant.permissions.includes("resource.read") ? [grant.actorId] : []);
  if (owners.length) scopes.push(and(inArray(repositories.visibility, ["private", "restricted"]), inArray(repositories.ownerId, owners), eq(repositories.ownerType, "human"))!);
  return and(or(...scopes) ?? sql`false`, sql`EXISTS (SELECT 1 FROM ${authActors} WHERE ${authActors.id}::text = ${repositories.createdBy})`)!;
}

export async function requireRepository(db: Database, authority: ResourceAuthority, id: string) {
  const [repository] = await db.select().from(repositories).where(and(eq(repositories.id, id), repositoryPredicate(authority)));
  if (!repository) throw new NotFoundError("Resource not found");
  return repository;
}
