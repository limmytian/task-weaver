import { revokeActorExecutions } from './execution-revocation';
import { and, eq, isNull, isNotNull, ilike, inArray, asc } from "drizzle-orm";
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
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_GRANTABLE_PERMISSIONS,
  issueScopedApiKeySchema,
  keyGrantOptionsSchema,
  apiKeySummaryDtoSchema,
  updateApiKeyGrantsSchema,
  createProjectSchema,
  createManagedAgentSchema,
  managedAgentDtoSchema,
  managedAgentListSchema,
  managedAgentProjectsSchema,
  setProjectMembershipSchema,
  projectMembershipDtoSchema,
  type VerifiedRequestContext,
  type ProjectRole,
  type AuthorizationGrant,
} from "@task-weaver/contracts";
import {
  type AuthDatabase,
  loadActivePrincipal,
  loadPrincipalGrants,
  intersectGrants,
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
  updateScopedApiKeyGrants,
  publicScopedApiKey,
  credentialManager,
  keyManager,
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
    deletedAt: actor.deletedAt?.toISOString() ?? null,
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
    if (actor.deletedAt) throw new NotFoundError("Agent not found");
    if (actor.status !== "active") throw new ValidationError("Agent is already disabled");
    const now = new Date();
    await revokeActorExecutions(dbOrTx, actor.id);
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
    async permissions(headers: Headers) {
      const context = await authentication.resolve(headers);
      const authority = await getLiveRequestAuthority(db, context);
      return { actor: authority.actor, grants: authority.grants };
    },
    async listAssignees(headers: Headers, projectId?: string) {
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const context = await authentication.resolve(headers);
        if (context.credential.kind === "delegation") throw new AuthorizationError();
        const authority = await getLiveRequestAuthority(tx, context);
        let actorIds: string[];
        if (projectId) {
          id(projectId);
          await requireLivePermission(tx, context, { scope: "project", projectId, permissions: ["resource.read"] });
          actorIds = (await tx.select({ member: projectMemberships }).from(projectMemberships)
            .innerJoin(authActors, eq(authActors.id, projectMemberships.actorId))
            .where(and(eq(projectMemberships.projectId, projectId), isNull(projectMemberships.removedAt),
              eq(authActors.status, "active"), isNull(authActors.deletedAt))))
            .filter(({ member }) => member.role !== "viewer").map(({ member }) => member.actorId);
        } else {
          if (authority.actor.type !== "human") throw new AuthorizationError();
          await requireLivePermission(tx, context, { scope: "personal", actorId: authority.actor.id, permissions: ["resource.read"] });
          actorIds = [authority.actor.id, ...(await tx.select().from(authActors).where(and(eq(authActors.managedByActorId, authority.actor.id), eq(authActors.status, "active"), isNull(authActors.deletedAt)))).map(actor => actor.id)];
        }
        const eligible = [];
        for (const actorId of actorIds) {
          try {
            const principal = await loadActivePrincipal(tx, actorId);
            const [actor] = await tx.select().from(authActors).where(eq(authActors.id, actorId));
            eligible.push({ id: principal.id, type: principal.type, displayName: actor!.displayName });
          } catch (error) {
            if (!(error instanceof AuthenticationError)) throw error;
          }
        }
        return eligible;
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
          .select({ membership: projectMemberships })
          .from(projectMemberships)
          .innerJoin(authActors, eq(authActors.id, projectMemberships.actorId))
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              isNull(projectMemberships.removedAt),
              isNull(authActors.deletedAt),
            ),
          )
      ).map(({ membership }) => membershipDto(membership));
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
        const subject = await loadActivePrincipal(tx, actorId).catch(error => {
          // An invalid target does not invalidate the caller's authenticated session.
          if (error instanceof AuthenticationError) throw new NotFoundError("Actor not found");
          throw error;
        });
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
        await revokeActorExecutions(tx, actorId, projectId);
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
        if (context.credential.kind === "session")
          await requireRecentSession(tx, context);
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
        await revokeActorExecutions(tx, actorId, projectId);
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
        await revokeActorExecutions(tx, targetActorId, projectId);
        await revokeActorExecutions(tx, authority.actor.id, projectId);
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
    async listAgents(headers: Headers, input: unknown = {}) {
      const parsed = managedAgentListSchema.parse(input);
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
              eq(authActors.status, parsed.status === "deleted" ? "disabled" : parsed.status),
              parsed.status === "deleted" ? isNotNull(authActors.deletedAt) : isNull(authActors.deletedAt),
              parsed.query ? ilike(authActors.displayName, `%${parsed.query.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
            ),
          )
          .orderBy(asc(authActors.createdAt), asc(authActors.id))
          .limit(parsed.pageSize)
          .offset((parsed.page - 1) * parsed.pageSize)
      ).map(agentDto);
    },
    async agentDetail(headers: Headers, actorId: string) {
      id(actorId);
      const context = await authentication.resolve(headers);
      const { actor } = await ownAgent(db, context, actorId);
      if (actor.deletedAt) throw new NotFoundError("Agent not found");
      return agentDto(actor);
    },
    async agentProjects(headers: Headers, input: unknown) {
      const parsed = managedAgentProjectsSchema.parse(input);
      const context = await authentication.resolve(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const { actor } = await ownAgent(tx, context, parsed.actorId);
        if (actor.deletedAt) throw new NotFoundError("Agent not found");
        const authority = await getLiveRequestAuthority(tx, context);
        const eligible = authority.grants.filter((grant) => grant.scope === "project" &&
          grant.permissions.includes(parsed.view === "available" ? "project.members.manage" : "resource.read"));
        const projectIds = eligible.flatMap(grant => grant.scope === "project" ? [grant.projectId] : []);
        if (!projectIds.length) return [];
        const rows = await tx.select({ project: projects, membership: projectMemberships })
          .from(projects)
          .leftJoin(projectMemberships, and(eq(projectMemberships.projectId, projects.id),
            eq(projectMemberships.actorId, actor.id), isNull(projectMemberships.removedAt)))
          .where(and(inArray(projects.id, projectIds), eq(projects.status, "active"),
            parsed.view === "memberships" ? isNotNull(projectMemberships.id) : undefined,
            parsed.query ? ilike(projects.name, `%${parsed.query.replace(/[\\%_]/g, "\\$&")}%`) : undefined))
          .orderBy(asc(projects.name), asc(projects.id)).limit(parsed.pageSize)
          .offset((parsed.page - 1) * parsed.pageSize);
        return rows.map(({ project, membership }) => {
          const grant = eligible.find(grant => grant.scope === "project" && grant.projectId === project.id)!;
          const canOwn = grant.permissions.includes("project.ownership.manage");
          const canManage = actor.status === "active" && grant.permissions.includes("project.members.manage") &&
            (canOwn || !membership || (membership.role !== "maintainer" && membership.role !== "owner"));
          return {
            project: { id: project.id, name: project.name },
            membership: membership ? membershipDto(membership) : null,
            rolePermissions: membership ? [...PROJECT_ROLE_PERMISSIONS[membership.role]] : [],
            canManage,
            roles: canOwn ? ["maintainer", "member", "viewer"] as const : ["member", "viewer"] as const,
            grantablePermissions: (canOwn ? PROJECT_ROLE_GRANTABLE_PERMISSIONS.owner : PROJECT_ROLE_GRANTABLE_PERMISSIONS.maintainer)
              .filter(permission => context.credential.kind === "session" || grant.permissions.includes(permission)),
          };
        });
      });
    },
    async deleteAgent(headers: Headers, actorId: string) {
      id(actorId);
      const context = await mutation(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await requireRecentSession(tx, context);
        const { actor, manager } = await ownAgent(tx, context, actorId);
        if (actor.deletedAt) throw new NotFoundError("Agent not found");
        if (actor.status !== "disabled") throw new ValidationError("Only disabled Agents can be deleted");
        await revokeActorExecutions(tx, actor.id);
        const [deleted] = await tx.update(authActors).set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(authActors.id, actor.id)).returning();
        await auditIdentity(tx, "agent.deleted", manager.id, actor.id);
        return agentDto(deleted!);
      });
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
    async keyGrantOptions(headers: Headers, actorId: string) {
      id(actorId);
      const context = await authentication.resolve(headers);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        // The same credential-manager check used for listing protects subject metadata.
        await credentialManager(tx, context, actorId, new Date(), true);
        const authority = await getLiveRequestAuthority(tx, context);
        return intersectGrants(authority.grants, await loadPrincipalGrants(tx, actorId));
      });
    },
    async pagedKeyGrantOptions(headers: Headers, input: unknown) {
      const parsed = keyGrantOptionsSchema.parse(input);
      const context = await authentication.resolve(headers);
      const actorId = parsed.actorId ?? context.actor.id;
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        await credentialManager(tx, context, actorId, new Date(), true);
        const authority = await getLiveRequestAuthority(tx, context);
        const eligible = intersectGrants(authority.grants, await loadPrincipalGrants(tx, actorId));
        const projectIds = eligible.flatMap(grant => grant.scope === "project" ? [grant.projectId] : []);
        const pattern = `%${parsed.query.replace(/[\\%_]/g, "\\$&")}%`;
        const namedProjects = projectIds.length ? await tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(inArray(projects.id, projectIds), parsed.query ? ilike(projects.name, pattern) : undefined)).orderBy(asc(projects.name), asc(projects.id)).limit(parsed.pageSize + 1).offset((parsed.page - 1) * parsed.pageSize) : [];
        const personalIds = eligible.flatMap(grant => grant.scope === "personal" ? [grant.actorId] : []);
        const humans = personalIds.length ? await tx.select({ id: authActors.id, name: authActors.displayName }).from(authActors).where(inArray(authActors.id, personalIds)) : [];
        const base = eligible.filter(grant => grant.scope !== "project").map(grant => ({ grant, label: grant.scope === "personal" ? `Personal: ${humans.find(human => human.id === grant.actorId)?.name ?? "Authorized owner"}` : grant.scope === "global" ? "Global resources" : "Instance administration" }));
        const items = namedProjects.slice(0, parsed.pageSize).map(project => ({ grant: eligible.find(grant => grant.scope === "project" && grant.projectId === project.id)!, label: project.name }));
        return { items: [...(parsed.page === 1 ? base.filter(item => item.label.toLowerCase().includes(parsed.query.toLowerCase())) : []), ...items], hasNext: namedProjects.length > parsed.pageSize, limit: 100 };
      });
    },
    async keySummaries(headers: Headers, input: unknown) {
      const parsed = keyGrantOptionsSchema.parse(input);
      const context = await authentication.resolve(headers);
      const actorId = parsed.actorId ?? context.actor.id;
      await credentialManager(db, context, actorId, new Date(), true);
      const pattern = `%${parsed.query.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await db.select({ id: apiKeys.id, actorId: apiKeys.actorId, issuedByActorId: apiKeys.issuedByActorId,
        name: apiKeys.name, prefix: apiKeys.keyPrefix, grantVersion: apiKeys.grantVersion,
        createdAt: apiKeys.createdAt, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt,
      }).from(apiKeys).where(and(eq(apiKeys.actorId, actorId), isNull(apiKeys.revokedAt), parsed.query ? ilike(apiKeys.name, pattern) : undefined))
        .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id)).limit(parsed.pageSize + 1).offset((parsed.page - 1) * parsed.pageSize);
      return { items: rows.slice(0, parsed.pageSize).map(row => apiKeySummaryDtoSchema.parse({ ...row,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
      })), hasNext: rows.length > parsed.pageSize };
    },
    async keyDetail(headers: Headers, actorId: string, keyId: string) {
      id(actorId); id(keyId);
      const context = await authentication.resolve(headers);
      await credentialManager(db, context, actorId, new Date(), true);
      const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.actorId, actorId))).limit(1);
      if (!key) throw new NotFoundError("API key not found");
      // Resolve only names the caller can currently read, retaining IDs for historical scopes.
      const authority = await getLiveRequestAuthority(db, context);
      const projectIds = authority.grants.flatMap(grant => grant.scope === "project" && grant.permissions.includes("resource.read") ? [grant.projectId] : []);
      const storedGrants = updateApiKeyGrantsSchema.shape.grants.parse(key.grants);
      const visibleIds = storedGrants.flatMap(grant => grant.scope === "project" && projectIds.includes(grant.projectId) ? [grant.projectId] : []);
      const names = visibleIds.length ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, visibleIds)) : [];
      const [subject] = await db.select({ name: authActors.displayName }).from(authActors).where(eq(authActors.id, actorId));
      return { ...publicScopedApiKey(key), subjectName: subject?.name ?? "Credential owner", namedGrants: storedGrants.map(grant => ({ grant, label: grant.scope === "project" ? names.find(project => project.id === grant.projectId)?.name ?? "Unavailable project" : grant.scope === "personal" ? "Managing human personal space" : grant.scope })) };
    },
    async updateKeyGrants(headers: Headers, actorId: string, keyId: string, input: unknown) {
      id(actorId); id(keyId);
      const context = await mutation(headers);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        await checkCredentialMutation(context, tx);
        await keyManager(tx, context, actorId, new Date());
        const parsed = updateApiKeyGrantsSchema.parse(input);
        const [previous] = await tx.select({ grants: apiKeys.grants }).from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.actorId, actorId)));
        if (previous && !grantsAreCovered(parsed.grants, updateApiKeyGrantsSchema.shape.grants.parse(previous.grants))) await requireRecentSession(tx, context);
        const result = await updateScopedApiKeyGrants(tx, context, actorId, keyId, parsed);
        if (result.changed) await auditIdentity(tx, "credential.grants_updated", context.actor.id, actorId, keyId, {
          previousVersion: parsed.expectedVersion,
          grantVersion: result.key.grantVersion,
          beforeGrants: JSON.stringify(previous!.grants),
          afterGrants: JSON.stringify(result.key.grants),
        });
        return result.key;
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
