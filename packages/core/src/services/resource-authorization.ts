import { and, eq, inArray, isNull, isNotNull, or, sql, type AnyColumn, type SQL, getTableName } from "drizzle-orm";
import {
  type Database, projects, tasks, requirements, documents, memories,
  executionSlices, authActors, mcpServers, projectMemberships, skillPackages, embeddingProfiles,
} from "@task-weaver/db";
import {
  AuthorizationError, NotFoundError, ValidationError, AuthenticationError, stableActorReferenceSchema,
  type AuthorizationGrant, type AuthorizationPermission, type VerifiedRequestContext,
} from "@task-weaver/contracts";
import { getLiveRequestAuthority } from "./api-keys";
import { grantsAreCovered, loadActivePrincipal, type AuthDatabase } from "./auth-principals";

export type ResourceKind = "project" | "requirement" | "task" | "document" | "memory" | "slice" | "package" | "profile" | "mcp";
export type ResourceScope = {
  projectId?: string | null;
  personalOwnerId?: string | null;
  personalOwnerType?: "human" | "agent" | null;
};
export type ResourceAuthority = Awaited<ReturnType<typeof getLiveRequestAuthority>>;

/** Resolve again for every operation. A parsed or previously verified snapshot is not authority. */
export async function resourceAuthority(db: AuthDatabase, context: VerifiedRequestContext) {
  if (!context) throw new AuthorizationError();
  return getLiveRequestAuthority(db, context);
}

export function scopeGrant(scope: ResourceScope, permission: AuthorizationPermission): AuthorizationGrant | null {
  if (scope.projectId) {
    if (scope.personalOwnerId || scope.personalOwnerType) return null;
    return { scope: "project", projectId: scope.projectId, permissions: [permission] };
  }
  if (scope.personalOwnerId || scope.personalOwnerType) {
    if (!scope.personalOwnerId || scope.personalOwnerType !== "human") return null;
    return { scope: "personal", actorId: scope.personalOwnerId, permissions: [permission] };
  }
  return { scope: "global", permissions: [permission] };
}

export function canAccessResource(authority: ResourceAuthority, scope: ResourceScope, permission: AuthorizationPermission = "resource.read") {
  const grant = scopeGrant(scope, permission);
  return grant !== null && grantsAreCovered([grant], authority.grants);
}

export function requireScope(authority: ResourceAuthority, scope: ResourceScope, permission: AuthorizationPermission = "resource.write") {
  if (!canAccessResource(authority, scope, permission)) throw new AuthorizationError();
}

/** SQL filtering precedes pagination and counts. Invalid/legacy owner combinations are quarantined. */
export function resourcePredicate(
  authority: ResourceAuthority,
  columns: { projectId: AnyColumn | SQL; personalOwnerId?: AnyColumn | SQL; personalOwnerType?: AnyColumn | SQL; createdBy?: AnyColumn | SQL },
  permission: AuthorizationPermission = "resource.read",
): SQL {
  const terms: SQL[] = [];
  const projectIds = authority.grants.flatMap(g => g.scope === "project" && g.permissions.includes(permission) ? [g.projectId] : []);
  const unowned = columns.personalOwnerId && columns.personalOwnerType
    ? and(isNull(columns.personalOwnerId), isNull(columns.personalOwnerType))!
    : sql`true`;
  if (projectIds.length) terms.push(and(inArray(sql`${columns.projectId}`, projectIds), unowned)!);
  if (columns.personalOwnerId && columns.personalOwnerType) {
    for (const grant of authority.grants) {
      if (grant.scope === "personal" && grant.permissions.includes(permission))
        terms.push(and(isNull(columns.projectId), eq(sql`${columns.personalOwnerId}`, grant.actorId), eq(sql`${columns.personalOwnerType}`, "human"))!);
    }
    if (authority.grants.some(g => g.scope === "global" && g.permissions.includes(permission)))
      terms.push(and(isNull(columns.projectId), unowned, columns.createdBy ? sql`EXISTS (SELECT 1 FROM ${authActors} WHERE ${qualifiedColumn(authActors.id)}::text = ${columns.createdBy})` : sql`false`)!);
  }
  return or(...terms) ?? sql`false`;
}

/** Scope-labelled assets must agree with their stored owner/project columns. */
export function labelledResourcePredicate(
  authority: ResourceAuthority,
  columns: { scope: AnyColumn; projectId: AnyColumn; personalOwnerId: AnyColumn; personalOwnerType: AnyColumn; createdBy: AnyColumn },
  permission: AuthorizationPermission = "resource.read",
) {
  return and(resourcePredicate(authority, columns, permission), or(
    and(eq(columns.scope, "project"), isNotNull(columns.projectId)),
    and(eq(columns.scope, "personal"), isNull(columns.projectId), isNotNull(columns.personalOwnerId), eq(columns.personalOwnerType, "human")),
    and(eq(columns.scope, "global"), isNull(columns.projectId), isNull(columns.personalOwnerId), isNull(columns.personalOwnerType)),
  ))!;
}

export function projectPredicate(authority: ResourceAuthority, permission: AuthorizationPermission = "resource.read", idColumn: AnyColumn | SQL = projects.id) {
  const ids = authority.grants.flatMap(g => g.scope === "project" && g.permissions.includes(permission) ? [g.projectId] : []);
  return ids.length ? inArray(sql`${idColumn}`, ids) : sql`false`;
}

export async function requireResource(db: Database, authority: ResourceAuthority, kind: ResourceKind, id: string, permission: AuthorizationPermission = "resource.read") {
  if (!stableActorReferenceSchema.safeParse({ id, type: "human" }).success) throw new ValidationError("Invalid resource ID");
  let scope: ResourceScope | undefined;
  if (kind === "project") {
    const row = await db.query.projects.findFirst({ where: eq(projects.id, id) });
    scope = row ? { projectId: row.id } : undefined;
  } else if (kind === "slice") {
    const row = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, id) });
    if (row) return requireResource(db, authority, "requirement", row.requirementId, permission);
  } else {
    const row = kind === "task" ? await db.query.tasks.findFirst({ where: eq(tasks.id, id) })
      : kind === "requirement" ? await db.query.requirements.findFirst({ where: eq(requirements.id, id) })
      : kind === "document" ? await db.query.documents.findFirst({ where: eq(documents.id, id) })
      : kind === "package" ? await db.query.skillPackages.findFirst({ where: eq(skillPackages.id, id) })
      : kind === "profile" ? await db.query.embeddingProfiles.findFirst({ where: eq(embeddingProfiles.id, id) })
      : kind === "mcp" ? await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) })
      : await db.query.memories.findFirst({ where: eq(memories.id, id) });
    scope = row;
    if (kind === "mcp" && row && "registeredBy" in row) {
      const creator = row.registeredBy ? await db.query.authActors.findFirst({ where: sql`${authActors.id}::text = ${row.registeredBy}` }) : undefined;
      if (!creator) scope = undefined;
    }
    if (kind === "profile" && row && "scope" in row) {
      const expected = row.projectId ? "project" : row.personalOwnerId ? "personal" : "global";
      if (row.scope !== expected) scope = undefined;
    }
    if (kind === "task" && row && "requirementId" in row && row.projectId) {
      const requirement = row.requirementId ? await db.query.requirements.findFirst({ where: eq(requirements.id, row.requirementId) }) : undefined;
      if (!requirement || requirement.projectId !== row.projectId) scope = undefined;
    }
    if (row && !row.projectId && !("personalOwnerId" in row && row.personalOwnerId) && "createdBy" in row) {
      const [creator] = await db.select({ id: authActors.id }).from(authActors).where(sql`${authActors.id}::text = ${row.createdBy}`).limit(1);
      if (!creator) scope = undefined;
    }
    if (kind === "task" && row && "requirementId" in row) {
      if (row.scope === "personal" && (!row.personalOwnerId || row.projectId || row.requirementId || row.executionSliceId)) scope = undefined;
      if (row.scope === "project" && (!row.projectId || !row.requirementId)) scope = undefined;
      if (row.executionSliceId) {
        const slice = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, row.executionSliceId) });
        if (!slice || slice.requirementId !== row.requirementId) scope = undefined;
      }
    }
  }
  if (!scope || !canAccessResource(authority, scope)) throw new NotFoundError("Resource not found");
  requireScope(authority, scope, permission);
  return scope;
}

export async function validateAssignee(db: Database, _authority: ResourceAuthority, scope: ResourceScope, actorId?: string | null, actorType?: "human" | "agent" | null) {
  if (!actorId) {
    if (actorType) throw new ValidationError("Assignee type requires an assignee");
    return;
  }
  if (!stableActorReferenceSchema.safeParse({ id: actorId, type: actorType }).success) throw new ValidationError("Assignee requires a stable actor ID and persisted type");
  let actor;
  try { actor = await loadActivePrincipal(db, actorId); }
  catch (error) {
    if (error instanceof AuthenticationError) throw new ValidationError("Assignee must be an active eligible actor");
    throw error;
  }
  if (actorType !== actor.type) throw new ValidationError("Assignee type must match its persisted identity");
  if (scope.projectId) {
    const membership = await db.query.projectMemberships.findFirst({ where: and(eq(projectMemberships.projectId, scope.projectId), eq(projectMemberships.actorId, actorId), isNull(projectMemberships.removedAt)) });
    if (!membership || membership.role === "viewer") throw new ValidationError("Assignee must be an eligible project member");
  } else if (actor.type === "human" ? actor.id !== scope.personalOwnerId : actor.managedByActorId !== scope.personalOwnerId) {
    throw new AuthorizationError();
  }
}

/** Attached memories cannot expose an inaccessible endpoint through title/content or entity metadata. */
export function memoryResourcePredicate(authority: ResourceAuthority) {
  return and(resourcePredicate(authority, memories), or(
    and(isNull(memories.entityId), isNull(memories.entityType)),
    and(eq(memories.entityType, "project"), sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${qualifiedColumn(projects.id)} = ${memories.entityId} AND ${projectPredicate(authority, "resource.read", qualifiedColumn(projects.id))})`),
    and(eq(memories.entityType, "requirement"), sql`EXISTS (SELECT 1 FROM ${requirements} WHERE ${qualifiedColumn(requirements.id)} = ${memories.entityId} AND ${resourcePredicate(authority, qualifiedScopeColumns(requirements))})`),
    and(eq(memories.entityType, "task"), sql`EXISTS (SELECT 1 FROM ${tasks} WHERE ${qualifiedColumn(tasks.id)} = ${memories.entityId} AND ${taskResourcePredicate(authority, true)})`),
    and(eq(memories.entityType, "document"), sql`EXISTS (SELECT 1 FROM ${documents} WHERE ${qualifiedColumn(documents.id)} = ${memories.entityId} AND ${resourcePredicate(authority, qualifiedScopeColumns(documents))})`),
  ))!;
}

/** Presentation default only; using it still requires an explicit personal resource grant. */
export function personalResourceOwnerId(context: VerifiedRequestContext) {
  return context.actor.type === "human" ? context.actor.id : context.actor.managedByActorId;
}

/** The task/requirement/slice relation is part of authorization, including list totals. */
export function taskResourcePredicate(authority: ResourceAuthority, qualified = false) {
  const column = (value: AnyColumn): SQL => qualified ? qualifiedColumn(value) : sql`${value}`;
  return and(resourcePredicate(authority, qualified ? qualifiedScopeColumns(tasks) : tasks), or(
    and(eq(column(tasks.scope), "personal"), isNotNull(column(tasks.personalOwnerId)), eq(column(tasks.personalOwnerType), "human"), isNull(column(tasks.projectId)), isNull(column(tasks.requirementId)), isNull(column(tasks.executionSliceId))),
    and(eq(column(tasks.scope), "project"), sql`EXISTS (SELECT 1 FROM ${requirements} WHERE ${qualifiedColumn(requirements.id)} = ${column(tasks.requirementId)} AND ${qualifiedColumn(requirements.projectId)} = ${column(tasks.projectId)})`,
      or(isNull(column(tasks.executionSliceId)), sql`EXISTS (SELECT 1 FROM ${executionSlices} WHERE ${qualifiedColumn(executionSlices.id)} = ${column(tasks.executionSliceId)} AND ${qualifiedColumn(executionSlices.requirementId)} = ${column(tasks.requirementId)})`)),
  ))!;
}

/** Inner subquery columns must not be remapped to a relational query's outer alias. */
export function qualifiedColumn(column: AnyColumn): SQL {
  const tableName = getTableName(column.table);
  const schema = tableName === "auth_actors" ? sql`${sql.identifier("task_weaver")}.` : sql``;
  return sql`${schema}${sql.identifier(tableName)}.${sql.identifier(column.name)}`;
}
export function qualifiedScopeColumns(columns: { projectId: AnyColumn; personalOwnerId?: AnyColumn; personalOwnerType?: AnyColumn; createdBy?: AnyColumn }) {
  return {
    projectId: qualifiedColumn(columns.projectId),
    personalOwnerId: columns.personalOwnerId ? qualifiedColumn(columns.personalOwnerId) : undefined,
    personalOwnerType: columns.personalOwnerType ? qualifiedColumn(columns.personalOwnerType) : undefined,
    createdBy: columns.createdBy ? qualifiedColumn(columns.createdBy) : undefined,
  };
}
