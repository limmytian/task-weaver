import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  runMigrations,
  authInstanceState,
  authSessions,
  authUsers,
  projectMemberships,
  authAuditEvents,
} from "@task-weaver/db";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "@task-weaver/contracts";
import { createAuthenticationService } from "./authentication";
import { createIdentityManagementService } from "./identity-management";
import { getLiveRequestAuthority } from "./api-keys";
import { getPersonalResourceOwner } from "./auth-principals";
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test(
  "identity management enforces ownership, approval boundaries and live credential ceilings",
  { skip: !databaseUrl, timeout: 150_000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/tw_auth_e2e");
    await runMigrations(databaseUrl!);
    const db = createDb(databaseUrl!);
    t.after(() => db.$client.end());
    await db
      .update(authInstanceState)
      .set({ initializedByUserId: null, initializedAt: null });
    const config = {
      secret: "fixture-auth-secret".repeat(3),
      bootstrapSecret: "fixture-bootstrap-secret".repeat(3),
      baseURL: "http://127.0.0.1:3001",
      trustedOrigins: ["http://127.0.0.1:3000"],
    };
    const auth = createAuthenticationService(db, config);
    const identity = createIdentityManagementService(db, auth);
    const password = randomBytes(24).toString("hex");
    const csrfHeaders = () => {
      const challenge = auth.csrfChallenge();
      return new Headers({
        cookie: challenge.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
        origin: config.trustedOrigins[0]!,
        "x-csrf-token": challenge.csrfToken,
      });
    };
    const login = async (email: string) => {
      const headers = csrfHeaders();
      const result = await auth.login(
        headers,
        { email, password },
        randomUUID(),
      );
      headers.set(
        "cookie",
        [
          headers.get("cookie"),
          ...result.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0]),
        ].join("; "),
      );
      return { headers, account: result.account, session: result.session };
    };
    const adminEmail = `${randomUUID()}@example.test`;
    await auth.bootstrap(
      csrfHeaders(),
      {
        email: adminEmail,
        displayName: "Admin",
        password,
        bootstrapSecret: config.bootstrapSecret,
      },
      "identity-bootstrap",
    );
    const admin = await login(adminEmail);
    const human = async () => {
      const email = `${randomUUID()}@example.test`;
      const invited = await auth.provision(admin.headers, {
        email,
        displayName: "Human",
      });
      await auth.activate(
        csrfHeaders(),
        { token: invited.activationToken, password },
        randomUUID(),
      );
      return login(email);
    };
    const owner = await human();
    const member = await human();
    const maintainer = await human();
    const outsider = await human();
    const project = await identity.createProject(owner.headers, {
      name: "Human-owned project",
    });
    await t.test(
      "active humans create projects with an atomic owner; admins have no implicit project access",
      async () => {
        const members = await identity.listMemberships(
          owner.headers,
          project.id,
        );
        assert.equal(members.length, 1);
        assert.equal(members[0]!.actor.id, owner.account.actorId);
        assert.equal(members[0]!.role, "owner");
        await assert.rejects(
          identity.listMemberships(admin.headers, project.id),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            admin.headers,
            project.id,
            outsider.account.actorId,
            { role: "member" },
          ),
          AuthorizationError,
        );
      },
    );
    await t.test(
      "members cannot self-promote; maintainers administer lower roles and approvals remain separate",
      async () => {
        await identity.setMembership(
          owner.headers,
          project.id,
          member.account.actorId,
          { role: "member" },
        );
        await identity.setMembership(
          owner.headers,
          project.id,
          maintainer.account.actorId,
          { role: "maintainer" },
        );
        await assert.rejects(
          identity.setMembership(
            member.headers,
            project.id,
            member.account.actorId,
            { role: "owner" },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            maintainer.account.actorId,
            { role: "maintainer", explicitPermissions: ["execution.merge"] },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            owner.account.actorId,
            { role: "viewer" },
          ),
          AuthorizationError,
        );
        await identity.setMembership(
          maintainer.headers,
          project.id,
          outsider.account.actorId,
          { role: "viewer", explicitPermissions: ["execution.review"] },
        );
        const authority = await getLiveRequestAuthority(
          db,
          await auth.resolve(outsider.headers),
        );
        assert.ok(
          authority.grants.some(
            (grant) =>
              grant.scope === "project" &&
              grant.projectId === project.id &&
              grant.permissions.includes("execution.review"),
          ),
        );
        const approver = await getLiveRequestAuthority(
          db,
          await auth.resolve(maintainer.headers),
        );
        assert.equal(
          approver.grants.some(
            (grant) =>
              grant.scope === "project" &&
              grant.permissions.includes("execution.review"),
          ),
          false,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            outsider.account.actorId,
            { role: "owner" },
          ),
          AuthorizationError,
        );
      },
    );
    await t.test(
      "scoped keys retain live membership limits and limited management keys cannot widen roles",
      async () => {
        const key = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Limited manager",
            expiresAt: null,
            grants: [
              {
                scope: "project",
                projectId: project.id,
                permissions: ["resource.read", "project.members.manage"],
              },
            ],
          },
        );
        const keyHeaders = new Headers({
          authorization: `Bearer ${key.rawKey}`,
        });
        await assert.rejects(
          identity.setMembership(
            keyHeaders,
            project.id,
            member.account.actorId,
            { role: "member" },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            keyHeaders,
            project.id,
            member.account.actorId,
            { role: "viewer", explicitPermissions: ["execution.merge"] },
          ),
          AuthorizationError,
        );
        await identity.setMembership(
          keyHeaders,
          project.id,
          member.account.actorId,
          { role: "viewer" },
        );
        const memberKey = await identity.issueKey(
          member.headers,
          member.account.actorId,
          {
            name: "Project reader",
            expiresAt: null,
            grants: [
              {
                scope: "project",
                projectId: project.id,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        await identity.removeMembership(
          owner.headers,
          project.id,
          member.account.actorId,
        );
        await assert.rejects(
          auth.resolve(
            new Headers({ authorization: `Bearer ${memberKey.rawKey}` }),
          ),
          AuthorizationError,
        );
      },
    );
    await t.test(
      "human and agent credentials preserve human ownership and require explicit personal grants",
      async () => {
        const agent = await identity.createAgent(owner.headers, {
          displayName: "Executor",
        });
        const humanKey = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Human key",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: [
                  "resource.read",
                  "resource.write",
                  "credential.manage",
                ],
              },
            ],
          },
        );
        const humanHeaders = new Headers({
          authorization: `Bearer ${humanKey.rawKey}`,
          "x-actor-id": agent.id,
          "x-actor-type": "agent",
        });
        const context = await auth.resolve(humanHeaders);
        assert.equal(context.actor.type, "human");
        assert.equal(context.actor.id, owner.account.actorId);
        assert.deepEqual(await getPersonalResourceOwner(db, context.actor.id), {
          personalOwnerId: owner.account.actorId,
          personalOwnerType: "human",
        });
        const agentKey = await identity.issueKey(owner.headers, agent.id, {
          name: "Agent key",
          expiresAt: null,
          grants: [
            {
              scope: "personal",
              actorId: owner.account.actorId,
              permissions: ["resource.read", "resource.write"],
            },
          ],
        });
        const agentHeaders = new Headers({
          authorization: `Bearer ${agentKey.rawKey}`,
        });
        const agentContext = await auth.resolve(agentHeaders);
        assert.equal(agentContext.actor.id, agent.id);
        assert.equal(agentContext.actor.type, "agent");
        assert.deepEqual(
          await getPersonalResourceOwner(db, agentContext.actor.id),
          {
            personalOwnerId: owner.account.actorId,
            personalOwnerType: "human",
          },
        );
        await assert.rejects(
          identity.listKeys(agentHeaders, owner.account.actorId),
          AuthorizationError,
        );
        await assert.rejects(
          identity.createProject(agentHeaders, { name: "Agent project" }),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(owner.headers, project.id, agent.id, {
            role: "owner",
          }),
          ValidationError,
        );
        await assert.rejects(
          identity.disableAgent(outsider.headers, agent.id),
          NotFoundError,
        );
        await identity.disableAgent(owner.headers, agent.id);
        await assert.rejects(auth.resolve(agentHeaders), AuthenticationError);
        await assert.rejects(
          identity.listKeys(outsider.headers, owner.account.actorId),
          AuthorizationError,
        );
        const child = await identity.issueKey(
          humanHeaders,
          owner.account.actorId,
          {
            name: "Narrow child",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        await identity.revokeKey(
          owner.headers,
          owner.account.actorId,
          humanKey.id,
        );
        await assert.rejects(
          auth.resolve(
            new Headers({ authorization: `Bearer ${child.rawKey}` }),
          ),
          AuthenticationError,
        );
      },
    );
    await t.test(
      "ownership transfer is atomic, human-only and requires recent authentication",
      async () => {
        const transferProject = await identity.createProject(owner.headers, {
          name: "Transfer",
        });
        await assert.rejects(
          identity.removeMembership(
            owner.headers,
            transferProject.id,
            owner.account.actorId,
          ),
          ValidationError,
        );
        await identity.transferOwnership(
          owner.headers,
          transferProject.id,
          outsider.account.actorId,
        );
        const list = await identity.listMemberships(
          outsider.headers,
          transferProject.id,
        );
        assert.equal(
          list.find((entry) => entry.actor.id === outsider.account.actorId)!
            .role,
          "owner",
        );
        assert.equal(
          list.find((entry) => entry.actor.id === owner.account.actorId)!.role,
          "maintainer",
        );
        const created = new Date(Date.now() - 1_000_000);
        await db
          .update(authSessions)
          .set({ createdAt: created, authenticatedAt: created })
          .where(eq(authSessions.id, outsider.session.id));
        await assert.rejects(
          identity.transferOwnership(
            outsider.headers,
            transferProject.id,
            owner.account.actorId,
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.issueKey(outsider.headers, outsider.account.actorId, {
            name: "Stale",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: outsider.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          }),
          AuthorizationError,
        );
        await auth.reauthenticate(
          outsider.headers,
          { password },
          "identity-reauth",
        );
      },
    );
    await t.test(
      "concurrent account disablement cannot eliminate the last active project owner",
      async () => {
        const first = await human();
        const second = await human();
        const guarded = await identity.createProject(first.headers, {
          name: "Protected",
        });
        await identity.setMembership(
          first.headers,
          guarded.id,
          second.account.actorId,
          { role: "owner" },
        );
        const results = await Promise.allSettled(
          [first, second].map((human) =>
            auth.setAccountState(admin.headers, human.account.id, {
              status: "disabled",
            }),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const memberships = await db
          .select({
            actorId: projectMemberships.actorId,
            status: authUsers.status,
          })
          .from(projectMemberships)
          .innerJoin(
            authUsers,
            eq(authUsers.actorId, projectMemberships.actorId),
          )
          .where(
            and(
              eq(projectMemberships.projectId, guarded.id),
              eq(projectMemberships.role, "owner"),
              isNull(projectMemberships.removedAt),
            ),
          );
        assert.equal(
          memberships.filter((membership) => membership.status === "active")
            .length,
          1,
        );
      },
    );
    await t.test(
      "rotation and agent administrative disable keep safe audited history",
      async () => {
        const key = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Rotate",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        const results = await Promise.allSettled(
          [0, 1].map(() =>
            identity.rotateKey(owner.headers, owner.account.actorId, key.id),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const agent = await identity.createAgent(owner.headers, {
          displayName: "Administrative fixture",
        });
        await assert.rejects(
          identity.disableAgentAsAdministrator(outsider.headers, agent.id),
          AuthorizationError,
        );
        await identity.disableAgentAsAdministrator(admin.headers, agent.id);
        const audits = await db.select().from(authAuditEvents);
        const serialized = JSON.stringify(audits);
        assert.equal(serialized.includes(key.rawKey), false);
        assert.equal(serialized.includes(password), false);
        assert.ok(
          audits.some(
            (audit) => audit.action === "project.ownership_transferred",
          ),
        );
      },
    );
  },
);
