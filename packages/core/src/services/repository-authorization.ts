import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { type Database, repositories, authActors } from "@task-weaver/db";
import { AuthorizationError, ValidationError, NotFoundError } from "@task-weaver/contracts";
import { loadActivePrincipal } from "./auth-principals";
import { requireScope, canAccessResource, type ResourceAuthority } from "./resource-authorization";

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


export async function requireCatalogManagement(db: Database, authority: ResourceAuthority, input: { visibility?: string; ownerId?: string | null; ownerType?: string | null }) {
  if (input.visibility === "instance") {
    if (input.ownerId || input.ownerType) throw new ValidationError("Instance repositories cannot set an owner");
    if (authority.actor.type !== "human" || authority.actor.instanceRole !== "admin") throw new AuthorizationError();
    requireScope(authority, {}, "repository.manage");
    return;
  }
  if (!["private", "restricted"].includes(input.visibility ?? "") || !input.ownerId || input.ownerType !== "human")
    throw new ValidationError("Private repositories require a human owner");
  requireScope(authority, { personalOwnerId: input.ownerId, personalOwnerType: "human" }, "repository.manage");
  const owner = await loadActivePrincipal(db, input.ownerId);
  if (owner.type !== "human") throw new ValidationError("Repository ownership must remain human");
}
