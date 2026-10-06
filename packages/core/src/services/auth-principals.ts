import { and, eq, isNull } from "drizzle-orm";
import {
  type Database,
  authActors,
  authUsers,
  projectMemberships,
  projects,
} from "@task-weaver/db";
import {
  AuthenticationError,
  AUTHORIZATION_SCOPE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  principalSchema,
  explicitProjectPermissionSchema,
  type AuthorizationGrant,
  type AuthorizationPermission,
  type Principal,
} from "@task-weaver/contracts";

export type AuthDatabase =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Resolve persisted identity, never historical labels or caller-declared Actor headers. */
async function loadPrincipal(
  db: AuthDatabase,
  actorId: string,
  requireActive: boolean,
): Promise<Principal> {
  const [actor] = await db
    .select()
    .from(authActors)
    .where(eq(authActors.id, actorId))
    .limit(1);
  if (!actor || (requireActive && actor.status !== "active"))
    throw new AuthenticationError("principal_disabled");
  if (actor.type === "human") {
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.actorId, actor.id))
      .limit(1);
    if (!user || (requireActive && user.status !== "active"))
      throw new AuthenticationError("principal_disabled");
    return principalSchema.parse({
      id: actor.id,
      type: "human",
      userId: user.id,
      status:
        actor.status === "active" && user.status === "active"
          ? "active"
          : "disabled",
      instanceRole: user.instanceRole,
    });
  }
  if (!actor.managedByActorId)
    throw new AuthenticationError("principal_disabled");
  const [manager] = await db
    .select({ actorStatus: authActors.status, userStatus: authUsers.status })
    .from(authUsers)
    .innerJoin(authActors, eq(authUsers.actorId, authActors.id))
    .where(
      and(
        eq(authActors.id, actor.managedByActorId),
        eq(authActors.type, "human"),
      ),
    )
    .limit(1);
  if (
    !manager ||
    (requireActive &&
      (manager.actorStatus !== "active" || manager.userStatus !== "active"))
  )
    throw new AuthenticationError("principal_disabled");
  return principalSchema.parse({
    id: actor.id,
    type: "agent",
    managedByActorId: actor.managedByActorId,
    status: actor.status,
  });
}

export function loadActivePrincipal(db: AuthDatabase, actorId: string) {
  return loadPrincipal(db, actorId, true);
}

/** Management may list/revoke a disabled subject's credentials without authenticating that subject. */
export function loadPrincipalForManagement(db: AuthDatabase, actorId: string) {
  return loadPrincipal(db, actorId, false);
}

/** Resolve the human owner independently of the actor that executes the operation. */
export async function getPersonalResourceOwner(
  db: AuthDatabase,
  actorId: string,
) {
  const principal = await loadActivePrincipal(db, actorId);
  return {
    personalOwnerId:
      principal.type === "human" ? principal.id : principal.managedByActorId,
    personalOwnerType: "human" as const,
  };
}

/** Live entitlements are separate from credential ceilings; admin does not imply project membership. */
export async function loadPrincipalGrants(
  db: AuthDatabase,
  actorId: string,
): Promise<AuthorizationGrant[]> {
  const principal = await loadActivePrincipal(db, actorId);
  const grants: AuthorizationGrant[] = [
    {
      scope: "personal",
      actorId:
        principal.type === "human" ? principal.id : principal.managedByActorId,
      permissions:
        principal.type === "human"
          ? [...AUTHORIZATION_SCOPE_PERMISSIONS.personal]
          : ["resource.read", "resource.write", "mcp.manage", "mcp.invoke", "repository.manage"],
    },
    {
      scope: "global",
      permissions:
        principal.type === "human" && principal.instanceRole === "admin"
          ? [...AUTHORIZATION_SCOPE_PERMISSIONS.global]
          : ["resource.read"],
    },
  ];
  if (principal.type === "human") {
    grants.push({
      scope: "instance",
      permissions:
        principal.instanceRole === "admin"
          ? [...AUTHORIZATION_SCOPE_PERMISSIONS.instance]
          : ["project.create"],
    });
  }
  const memberships = await db
    .select({ membership: projectMemberships })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(
      and(
        eq(projectMemberships.actorId, principal.id),
        isNull(projectMemberships.removedAt),
        eq(projects.status, "active"),
      ),
    );
  for (const { membership } of memberships) {
    if (!Object.hasOwn(PROJECT_ROLE_PERMISSIONS, membership.role)) continue;
    const explicit = membership.explicitPermissions.map((permission) =>
      explicitProjectPermissionSchema.parse(permission),
    );
    grants.push({
      scope: "project",
      projectId: membership.projectId,
      permissions: [
        ...new Set<AuthorizationPermission>([
          ...PROJECT_ROLE_PERMISSIONS[membership.role],
          ...explicit,
        ]),
      ],
    });
  }
  return grants;
}

function sameScope(left: AuthorizationGrant, right: AuthorizationGrant) {
  return (
    left.scope === right.scope &&
    (left.scope === "personal"
      ? right.scope === "personal" && left.actorId === right.actorId
      : left.scope === "project"
        ? right.scope === "project" && left.projectId === right.projectId
        : true)
  );
}

export function intersectGrants(
  grants: AuthorizationGrant[],
  ceiling: AuthorizationGrant[],
): AuthorizationGrant[] {
  return grants.flatMap((grant) => {
    const permissions = grant.permissions.filter((permission) =>
      ceiling.some(
        (bound) =>
          sameScope(grant, bound) && bound.permissions.includes(permission),
      ),
    );
    return permissions.length
      ? [{ ...grant, permissions } as AuthorizationGrant]
      : [];
  });
}

export function grantsAreCovered(
  grants: AuthorizationGrant[],
  ceiling: AuthorizationGrant[],
) {
  return grants.every((grant) =>
    grant.permissions.every((permission) =>
      ceiling.some(
        (bound) =>
          sameScope(grant, bound) && bound.permissions.includes(permission),
      ),
    ),
  );
}
