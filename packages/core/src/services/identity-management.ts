import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  type Database,
  authActors,
  projectMemberships,
  projects,
  apiKeys,
  apiKeyEvents,
} from "@task-weaver/db";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_GRANTABLE_PERMISSIONS,
  issueScopedApiKeySchema,
  createProjectSchema,
  createManagedAgentSchema,
  managedAgentDtoSchema,
  setProjectMembershipSchema,
  projectMembershipDtoSchema,
  type VerifiedRequestContext,
  type ProjectRole,
  type AuthorizationGrant,
} from "@task-weaver/contracts";
import {
  type AuthDatabase,
  loadActivePrincipal,
  grantsAreCovered,
} from "./auth-principals";
import {
  auditIdentity,
  guardAuthenticationOperations,
  lockIdentityLifecycle,
  requireLivePermission,
  requireRecentSession,
} from "./auth-security";
import {
  assertOtherActiveOwner,
  type createAuthenticationService,
} from "./authentication";
import {
  getLiveRequestAuthority,
  issueScopedApiKey,
  listScopedApiKeys,
  revokeScopedApiKey,
  rotateScopedApiKey,
} from "./api-keys";

type AuthenticationService = ReturnType<typeof createAuthenticationService>;
const id = (value: string) => z.string().uuid().parse(value);
const membershipDto = (membership: typeof projectMemberships.$inferSelect) =>
  projectMembershipDtoSchema.parse({
    id: membership.id,
    projectId: membership.projectId,
    actor: { id: membership.actorId, type: membership.actorType },
    role: membership.role,
    explicitPermissions: membership.explicitPermissions,
    createdAt: membership.createdAt.toISOString(),
  });
const agentDto = (actor: typeof authActors.$inferSelect) =>
  managedAgentDtoSchema.parse({
    id: actor.id,
    type: actor.type,
    managedByActorId: actor.managedByActorId,
    displayName: actor.displayName,
    status: actor.status,
    createdAt: actor.createdAt.toISOString(),
  });
const noStore = (): Headers => new Headers({ "cache-control": "no-store" });
const roleRank: Record<ProjectRole, number> = {
  viewer: 0,
  member: 1,
  maintainer: 2,
  owner: 3,
};

/** All service methods receive the factory resolver; adapters cannot accept contexts from JSON. */
export function createIdentityManagementService(
  db: Database,
  authentication: Pick<AuthenticationService, "resolve" | "assertMutation">,
) {
  async function mutation(headers: Headers) {
    authentication.assertMutation(headers);
    return authentication.resolve(headers);
  }
  async function activeProject(dbOrTx: AuthDatabase, projectId: string) {
    const [project] = await dbOrTx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.status, "active")));
    if (!project) throw new NotFoundError("Project not found");
  }
  async function memberAdministrator(
    dbOrTx: AuthDatabase,
    context: VerifiedRequestContext,
    projectId: string,
  ) {
    await activeProject(dbOrTx, projectId);
    const authority = await requireLivePermission(dbOrTx, context, {
      scope: "project",
      projectId,
      permissions: ["project.members.manage"],
    });
    const [membership] = await dbOrTx
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.actorId, authority.actor.id),
          isNull(projectMemberships.removedAt),
        ),
      );
    if (
      !membership ||
      (membership.role !== "owner" && membership.role !== "maintainer") ||
      authority.actor.type !== "human"
    )
      throw new AuthorizationError();
    return { authority, membership };
  }
  async function ownAgent(
    dbOrTx: AuthDatabase,
    context: VerifiedRequestContext,
    actorId: string,
  ) {
    const authority = await getLiveRequestAuthority(dbOrTx, context);
    if (authority.actor.type !== "human") throw new AuthorizationError();
    await requireLivePermission(dbOrTx, context, {
      scope: "personal",
      actorId: authority.actor.id,
      permissions: ["agent.manage"],
    });
    const [actor] = await dbOrTx
      .select()
      .from(authActors)
      .where(
        and(
          eq(authActors.id, actorId),
          eq(authActors.type, "agent"),
          eq(authActors.managedByActorId, authority.actor.id),
        ),
      );
    if (!actor) throw new NotFoundError("Agent not found");
    return { actor, manager: authority.actor };
  }
  async function checkCredentialMutation(
    context: VerifiedRequestContext,
    dbOrTx: AuthDatabase = db,
  ) {
    // Explicit human-bound credential.manage keys may mint only parent-bounded descendants.
    // Browser credential mutations require recent password authentication.
    if (context.credential.kind === "session")
      await requireRecentSession(dbOrTx, context);
    return getLiveRequestAuthority(dbOrTx, context);
  }
  async function disableAgent(
    dbOrTx: AuthDatabase,
    actor: typeof authActors.$inferSelect,
    byActorId: string,
  ) {
    const now = new Date();
    const [disabled] = await dbOrTx
      .update(authActors)
      .set({ status: "disabled", updatedAt: now })
      .where(eq(authActors.id, actor.id))
      .returning();
    const revoked = await dbOrTx
      .update(apiKeys)
      .set({ revokedAt: now, revokedByActorId: byActorId })
      .where(and(eq(apiKeys.actorId, actor.id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (revoked.length)
      await dbOrTx.insert(apiKeyEvents).values(
        revoked.map((key) => ({
          action: "revoked" as const,
          keyId: key.id,
          actorId: byActorId,
          createdAt: now,
        })),
      );
    await auditIdentity(dbOrTx, "agent.disabled", byActorId, actor.id);
    return agentDto(disabled!);
  }
  return guardAuthenticationOperations({
    async createProject(headers: Headers, input: unknown) {
      const parsed = createProjectSchema.strict().parse(input);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const authority = await requireLivePermission(tx, context, {
          scope: "instance",
          permissions: ["project.create"],
        });
        if (authority.actor.type !== "human") throw new AuthorizationError();
        const [project] = await tx
          .insert(projects)
          .values({ ...parsed, createdBy: authority.actor.id })
          .returning();
        await tx.insert(projectMemberships).values({
          projectId: project!.id,
          actorId: authority.actor.id,
          actorType: "human",
          role: "owner",
        });
        await auditIdentity(
          tx,
          "project.created",
          authority.actor.id,
          authority.actor.id,
          project!.id,
        );
        return project!;
      });
    },
    async listMemberships(headers: Headers, projectId: string) {
      id(projectId);
      const context = await authentication.resolve(headers);
      await requireLivePermission(db, context, {
        scope: "project",
        projectId,
        permissions: ["resource.read"],
      });
      return (
        await db
          .select()
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              isNull(projectMemberships.removedAt),
            ),
          )
      ).map(membershipDto);
    },
    async setMembership(
      headers: Headers,
      projectId: string,
      actorId: string,
      input: unknown,
    ) {
      id(projectId);
      id(actorId);
      const parsed = setProjectMembershipSchema.parse(input);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const { authority, membership: caller } = await memberAdministrator(
          tx,
          context,
          projectId,
        );
        // Changes to one's own role/explicit rights require another administrator's approval.
        if (actorId === authority.actor.id) throw new AuthorizationError();
        const subject = await loadActivePrincipal(tx, actorId);
        const [existing] = await tx
          .select()
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              eq(projectMemberships.actorId, actorId),
            ),
          );
        if (
          caller.role === "maintainer" &&
          (roleRank[parsed.role] >= roleRank.maintainer ||
            (existing &&
              !existing.removedAt &&
              roleRank[existing.role] >= roleRank.maintainer))
        )
          throw new AuthorizationError();
        if (
          parsed.role === "owner" ||
          (existing?.role === "owner" && !existing.removedAt)
        ) {
          await requireRecentSession(tx, context);
          await requireLivePermission(tx, context, {
            scope: "project",
            projectId,
            permissions: ["project.ownership.manage"],
          });
          if (subject.type !== "human")
            throw new ValidationError(
              "Project ownership requires an active human",
            );
        }
        if (
          parsed.explicitPermissions.some(
            (permission) =>
              !(
                PROJECT_ROLE_GRANTABLE_PERMISSIONS[
                  caller.role
                ] as readonly string[]
              ).includes(permission),
          )
        )
          throw new AuthorizationError();
        if (context.credential.kind === "session") {
          await requireRecentSession(tx, context);
        } else {
          // A limited API key cannot use membership management to exceed its credential ceiling.
          const requested: AuthorizationGrant = {
            scope: "project",
            projectId,
            permissions: [
              ...new Set([
                ...PROJECT_ROLE_PERMISSIONS[parsed.role],
                ...parsed.explicitPermissions,
              ]),
            ],
          };
          if (!grantsAreCovered([requested], authority.grants))
            throw new AuthorizationError();
        }
        if (
          existing?.role === "owner" &&
          !existing.removedAt &&
          parsed.role !== "owner"
        )
          await assertOtherActiveOwner(tx, projectId, actorId);
        const [membership] = await tx
          .insert(projectMemberships)
          .values({ projectId, actorId, actorType: subject.type, ...parsed })
          .onConflictDoUpdate({
            target: [projectMemberships.projectId, projectMemberships.actorId],
            set: { ...parsed, removedAt: null, updatedAt: new Date() },
          })
          .returning();
        await auditIdentity(
          tx,
          "project.membership_changed",
          authority.actor.id,
          subject.id,
          membership!.id,
          {
            projectId,
            role: parsed.role,
            explicitPermissions: parsed.explicitPermissions.join(","),
          },
        );
        return membershipDto(membership!);
      });
    },
    async removeMembership(
      headers: Headers,
      projectId: string,
      actorId: string,
    ) {
      id(projectId);
      id(actorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const { authority, membership: caller } = await memberAdministrator(
          tx,
          context,
          projectId,
        );
        const [existing] = await tx
          .select()
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              eq(projectMemberships.actorId, actorId),
              isNull(projectMemberships.removedAt),
            ),
          );
        if (!existing) throw new NotFoundError("Membership not found");
        if (
          caller.role === "maintainer" &&
          roleRank[existing.role] >= roleRank.maintainer
        )
          throw new AuthorizationError();
        if (existing.role === "owner") {
          await requireRecentSession(tx, context);
          await requireLivePermission(tx, context, {
            scope: "project",
            projectId,
            permissions: ["project.ownership.manage"],
          });
          await assertOtherActiveOwner(tx, projectId, actorId);
        }
        const removedAt = new Date();
        await tx
          .update(projectMemberships)
          .set({ removedAt, updatedAt: removedAt })
          .where(eq(projectMemberships.id, existing.id));
        await auditIdentity(
          tx,
          "project.membership_removed",
          authority.actor.id,
          actorId,
          existing.id,
          { projectId },
        );
        return { id: existing.id, removedAt: removedAt.toISOString() };
      });
    },
    async transferOwnership(
      headers: Headers,
      projectId: string,
      targetActorId: string,
    ) {
      id(projectId);
      id(targetActorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const { authority, membership: caller } = await memberAdministrator(
          tx,
          context,
          projectId,
        );
        await requireRecentSession(tx, context);
        await requireLivePermission(tx, context, {
          scope: "project",
          projectId,
          permissions: ["project.ownership.manage"],
        });
        if (caller.role !== "owner" || targetActorId === authority.actor.id)
          throw new AuthorizationError();
        const target = await loadActivePrincipal(tx, targetActorId);
        if (target.type !== "human")
          throw new ValidationError(
            "Project ownership requires an active human",
          );
        const [membership] = await tx
          .insert(projectMemberships)
          .values({
            projectId,
            actorId: target.id,
            actorType: "human",
            role: "owner",
          })
          .onConflictDoUpdate({
            target: [projectMemberships.projectId, projectMemberships.actorId],
            set: { role: "owner", removedAt: null, updatedAt: new Date() },
          })
          .returning();
        await tx
          .update(projectMemberships)
          .set({ role: "maintainer", updatedAt: new Date() })
          .where(eq(projectMemberships.id, caller.id));
        await auditIdentity(
          tx,
          "project.ownership_transferred",
          authority.actor.id,
          target.id,
          membership!.id,
          { projectId },
        );
        return membershipDto(membership!);
      });
    },
    async createAgent(headers: Headers, input: unknown) {
      const parsed = createManagedAgentSchema.parse(input);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const authority = await getLiveRequestAuthority(tx, context);
        if (authority.actor.type !== "human") throw new AuthorizationError();
        await requireRecentSession(tx, context);
        await requireLivePermission(tx, context, {
          scope: "personal",
          actorId: authority.actor.id,
          permissions: ["agent.manage"],
        });
        const [actor] = await tx
          .insert(authActors)
          .values({
            ...parsed,
            type: "agent",
            status: "active",
            managedByActorId: authority.actor.id,
            managedByActorType: "human",
          })
          .returning();
        await auditIdentity(tx, "agent.created", authority.actor.id, actor!.id);
        return agentDto(actor!);
      });
    },
    async listAgents(headers: Headers) {
      const context = await authentication.resolve(headers);
      const authority = await getLiveRequestAuthority(db, context);
      if (authority.actor.type !== "human") throw new AuthorizationError();
      await requireLivePermission(db, context, {
        scope: "personal",
        actorId: authority.actor.id,
        permissions: ["agent.manage"],
      });
      return (
        await db
          .select()
          .from(authActors)
          .where(
            and(
              eq(authActors.type, "agent"),
              eq(authActors.managedByActorId, authority.actor.id),
            ),
          )
      ).map(agentDto);
    },
    async disableAgent(headers: Headers, actorId: string) {
      id(actorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await requireRecentSession(tx, context);
        const { actor, manager } = await ownAgent(tx, context, actorId);
        return disableAgent(tx, actor, manager.id);
      });
    },
    async disableAgentAsAdministrator(headers: Headers, actorId: string) {
      id(actorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await requireRecentSession(tx, context);
        const authority = await requireLivePermission(tx, context, {
          scope: "instance",
          permissions: ["instance.manage", "agent.manage"],
        });
        const [actor] = await tx
          .select()
          .from(authActors)
          .where(and(eq(authActors.id, actorId), eq(authActors.type, "agent")));
        if (!actor) throw new NotFoundError("Agent not found");
        return disableAgent(tx, actor, authority.actor.id);
      });
    },
    async issueKey(headers: Headers, actorId: string, input: unknown) {
      id(actorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await checkCredentialMutation(context, tx);
        const result = await issueScopedApiKey(
          tx,
          context,
          actorId,
          issueScopedApiKeySchema.parse(input),
        );
        await auditIdentity(
          tx,
          "credential.issued",
          context.actor.id,
          actorId,
          result.id,
        );
        return { ...result, headers: noStore() };
      });
    },
    async listKeys(headers: Headers, actorId: string) {
      id(actorId);
      const context = await authentication.resolve(headers);
      return listScopedApiKeys(db, context, actorId);
    },
    async revokeKey(headers: Headers, actorId: string, keyId: string) {
      id(actorId);
      id(keyId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await checkCredentialMutation(context, tx);
        if (
          !(
            await tx
              .select({ id: apiKeys.id })
              .from(apiKeys)
              .where(and(eq(apiKeys.id, keyId), eq(apiKeys.actorId, actorId)))
          ).length
        )
          throw new NotFoundError("API key not found");
        const result = await revokeScopedApiKey(tx, context, keyId);
        await auditIdentity(
          tx,
          "credential.revoked",
          context.actor.id,
          actorId,
          keyId,
        );
        return result;
      });
    },
    async rotateKey(headers: Headers, actorId: string, keyId: string) {
      id(actorId);
      id(keyId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await checkCredentialMutation(context, tx);
        if (
          !(
            await tx
              .select({ id: apiKeys.id })
              .from(apiKeys)
              .where(and(eq(apiKeys.id, keyId), eq(apiKeys.actorId, actorId)))
          ).length
        )
          throw new NotFoundError("API key not found");
        const result = await rotateScopedApiKey(tx, context, keyId);
        await auditIdentity(
          tx,
          "credential.rotated",
          context.actor.id,
          actorId,
          result.id,
        );
        return { ...result, headers: noStore() };
      });
    },
  });
}
