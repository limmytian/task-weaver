import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  runMigrations,
  authActors,
  authUsers,
  authSessions,
  projects,
  projectMemberships,
  apiKeys,
  apiKeyEvents,
} from "@task-weaver/db";
import {
  requestIdentitySnapshotSchema,
  AuthorizationError,
  AuthenticationError,
  NotFoundError,
  type AuthorizationGrant,
  type VerifiedRequestContext,
} from "@task-weaver/contracts";
import * as service from "./api-keys";

const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;
test(
  "scoped keys enforce live authority, stable identity, revocation and safe atomic rotation",
  { skip: !databaseUrl, timeout: 60_000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(
      url.pathname,
      "/tw_auth_e2e",
      "Use only the disposable authentication database",
    );
    await runMigrations(databaseUrl!);
    const db = createDb(databaseUrl!);
    t.after(() => db.$client.end());
    async function human(role: "user" | "admin" = "user") {
      const [actor] = await db
        .insert(authActors)
        .values({ type: "human", displayName: "Fixture", status: "active" })
        .returning();
      const [user] = await db
        .insert(authUsers)
        .values({
          actorId: actor!.id,
          name: "Fixture",
          email: `${randomUUID()}@example.test`,
          status: "active",
          instanceRole: role,
        })
        .returning();
      const now = new Date();
      const expiry = new Date(now.getTime() + 3_600_000);
      const [session] = await db
        .insert(authSessions)
        .values({
          userId: user!.id,
          token: randomUUID(),
          createdAt: now,
          expiresAt: expiry,
          absoluteExpiresAt: expiry,
          idleExpiresAt: expiry,
        })
        .returning();
      // Test fixture for the future provider resolver; real entry points must never cast request data.
      const context = requestIdentitySnapshotSchema.parse({
        actor: {
          id: actor!.id,
          type: "human",
          userId: user!.id,
          status: "active",
          instanceRole: role,
        },
        credential: {
          id: session!.id,
          kind: "session",
          actorId: actor!.id,
          expiresAt: expiry.toISOString(),
        },
        verifiedAt: now.toISOString(),
      }) as VerifiedRequestContext;
      return { actor: actor!, user: user!, session: session!, context };
    }
    const owner = await human();
    const admin = await human("admin");
    const other = await human();
    const [project] = await db
      .insert(projects)
      .values({ name: "Key fixture", createdBy: owner.actor.id })
      .returning();
    const [otherProject] = await db
      .insert(projects)
      .values({ name: "Other fixture", createdBy: other.actor.id })
      .returning();
    const [membership] = await db
      .insert(projectMemberships)
      .values({
        projectId: project!.id,
        actorId: owner.actor.id,
        actorType: "human",
        role: "owner",
      })
      .returning();
    const personal: AuthorizationGrant = {
      scope: "personal",
      actorId: owner.actor.id,
      permissions: ["credential.manage"],
    };
    const read: AuthorizationGrant = {
      scope: "project",
      projectId: project!.id,
      permissions: ["resource.read"],
    };
    const write: AuthorizationGrant = {
      ...read,
      permissions: ["resource.read", "resource.write"],
    };
    const year = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const issue = (
      grants: AuthorizationGrant[],
      expiresAt: string | null = null,
    ) =>
      service.issueScopedApiKey(db, owner.context, owner.actor.id, {
        name: "Fixture key",
        grants,
        expiresAt,
      });

    await t.test(
      "explicit expiry and strict payloads; no administrator content override",
      async () => {
        await assert.rejects(
          service.issueScopedApiKey(db, owner.context, owner.actor.id, {
            name: "Missing expiry",
            grants: [read],
          } as never),
        );
        await assert.rejects(
          service.issueScopedApiKey(db, owner.context, owner.actor.id, {
            name: "Caller identity",
            grants: [read],
            expiresAt: null,
            actorId: other.actor.id,
          } as never),
        );
        await assert.rejects(issue([read], new Date(0).toISOString()));
        await assert.rejects(
          issue([{ ...read, projectId: otherProject!.id }]),
          AuthorizationError,
        );
        await assert.rejects(
          issue([
            {
              scope: "personal",
              actorId: other.actor.id,
              permissions: ["resource.read"],
            },
          ]),
          AuthorizationError,
        );
        await assert.rejects(
          issue([{ scope: "instance", permissions: ["instance.manage"] }]),
          AuthorizationError,
        );
        await assert.rejects(
          issue([{ ...read, permissions: ["execution.review"] }]),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, admin.context, admin.actor.id, {
            name: "Admin project",
            grants: [read],
            expiresAt: null,
          }),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, admin.context, owner.actor.id, {
            name: "Admin personal",
            grants: [personal],
            expiresAt: null,
          }),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, other.context, owner.actor.id, {
            name: "Other subject",
            grants: [read],
            expiresAt: null,
          }),
          AuthorizationError,
        );
        const creation = await issue([
          { scope: "instance", permissions: ["project.create"] },
        ]);
        assert.equal(
          (await service.authenticateScopedApiKey(db, creation.rawKey)).actor
            .type,
          "human",
        );
      },
    );

    const root = await issue([personal, write]);
    const context = await service.authenticateScopedApiKey(db, root.rawKey);
    await t.test(
      "raw material delivered once, hash never returned, stable human actor",
      async () => {
        assert.match(root.rawKey, /^tw_[0-9a-f]{64}$/);
        assert.ok(!("keyHash" in root));
        await assert.rejects(
          service.revokeScopedApiKey(db, other.context, root.id),
          NotFoundError,
        );
        await assert.rejects(
          service.rotateScopedApiKey(db, other.context, root.id),
          NotFoundError,
        );
        assert.equal(root.expiresAt, null);
        assert.equal(context.actor.id, owner.actor.id);
        assert.equal(context.actor.type, "human");
        const [stored] = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, root.id));
        assert.equal(
          stored!.keyHash,
          createHash("sha256").update(root.rawKey).digest("hex"),
        );
        const listed = await service.listScopedApiKeys(
          db,
          owner.context,
          owner.actor.id,
        );
        assert.ok(
          listed.every((key) => !("keyHash" in key) && !("rawKey" in key)),
        );
        assert.equal(
          await service.validateApiKey(db, root.rawKey),
          null,
          "Legacy middleware cannot downgrade a bound credential",
        );
        await assert.rejects(service.rotateApiKey(db, root.id));
        await assert.rejects(service.revokeApiKey(db, root.id));
      },
    );

    await t.test(
      "token cannot mint wider scopes, permissions or lifetime",
      async () => {
        const parent = await issue([personal, read], year);
        const restricted = await service.authenticateScopedApiKey(
          db,
          parent.rawKey,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, restricted, owner.actor.id, {
            name: "Broader",
            grants: [write],
            expiresAt: year,
          }),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, restricted, owner.actor.id, {
            name: "Never",
            grants: [read],
            expiresAt: null,
          }),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, restricted, owner.actor.id, {
            name: "Longer",
            grants: [read],
            expiresAt: new Date(Date.parse(year) + 1).toISOString(),
          }),
          AuthorizationError,
        );
        const child = await service.issueScopedApiKey(
          db,
          restricted,
          owner.actor.id,
          { name: "Narrower", grants: [read], expiresAt: year },
        );
        assert.equal(
          (await service.authenticateScopedApiKey(db, child.rawKey)).actor.id,
          owner.actor.id,
        );
        await assert.rejects(
          service.issueScopedApiKey(
            db,
            await service.authenticateScopedApiKey(db, child.rawKey),
            owner.actor.id,
            {
              name: "Without credential management",
              grants: [read],
              expiresAt: year,
            },
          ),
          AuthorizationError,
        );
        const rotatedChild = await service.rotateScopedApiKey(
          db,
          owner.context,
          child.id,
        );
        const [storedChild] = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, rotatedChild.id));
        assert.equal(
          storedChild!.parentKeyId,
          parent.id,
          "Browser rotation cannot detach a parent restriction",
        );
        const revoked = await service.revokeScopedApiKey(
          db,
          owner.context,
          parent.id,
        );
        assert.ok(revoked.revokedAt && !("keyHash" in revoked));
        await assert.rejects(
          service.authenticateScopedApiKey(db, rotatedChild.rawKey),
          AuthenticationError,
        );
        await assert.rejects(
          service.authenticateScopedApiKey(db, parent.rawKey),
          AuthenticationError,
        );
        await assert.rejects(
          service.authenticateScopedApiKey(db, child.rawKey),
          AuthenticationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, restricted, owner.actor.id, {
            name: "Stale context",
            grants: [read],
            expiresAt: year,
          }),
          AuthenticationError,
        );
        assert.ok(
          !(
            await service.listScopedApiKeys(db, owner.context, owner.actor.id)
          ).some((key) => key.id === parent.id),
        );
      },
    );

    await t.test(
      "rotation retains effective grants and tombstones, has one concurrent winner",
      async () => {
        const outcomes = await Promise.allSettled([
          service.rotateScopedApiKey(db, owner.context, root.id),
          service.rotateScopedApiKey(db, owner.context, root.id),
        ]);
        assert.equal(
          outcomes.filter((outcome) => outcome.status === "fulfilled").length,
          1,
        );
        const winner = outcomes.find(
          (outcome) => outcome.status === "fulfilled",
        )!;
        assert.equal(winner.status, "fulfilled");
        if (winner.status !== "fulfilled") return;
        const rotated = winner.value;
        assert.equal(rotated.actorId, root.actorId);
        assert.deepEqual(rotated.grants, root.grants);
        assert.equal(rotated.expiresAt, null);
        assert.equal(rotated.previousKeyId, root.id);
        assert.ok(!("keyHash" in rotated));
        await assert.rejects(
          service.authenticateScopedApiKey(db, root.rawKey),
          AuthenticationError,
        );
        assert.equal(
          (await service.authenticateScopedApiKey(db, rotated.rawKey)).actor.id,
          owner.actor.id,
        );
        const [old] = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, root.id));
        assert.ok(old!.revokedAt);
        const events = await db
          .select()
          .from(apiKeyEvents)
          .where(eq(apiKeyEvents.keyId, rotated.id));
        assert.equal(events[0]!.previousKeyId, root.id);
        assert.ok(!JSON.stringify(events).includes(rotated.rawKey));
        assert.ok(!JSON.stringify(events).includes(old!.keyHash));
        assert.equal(
          (
            await db
              .select()
              .from(projectMemberships)
              .where(eq(projectMemberships.id, membership!.id))
          )[0]!.actorId,
          owner.actor.id,
        );
        await assert.rejects(db.delete(apiKeys).where(eq(apiKeys.id, root.id)));
      },
    );

    await t.test(
      "live role reductions narrow keys and rotation; removal blocks project grants",
      async () => {
        const key = await issue([personal, write]);
        await db
          .update(projectMemberships)
          .set({ role: "viewer" })
          .where(eq(projectMemberships.id, membership!.id));
        const narrowed = await service.authenticateScopedApiKey(db, key.rawKey);
        assert.deepEqual(
          narrowed.credential.kind === "api_key" && narrowed.credential.grants,
          [personal, read],
        );
        const rotated = await service.rotateScopedApiKey(
          db,
          owner.context,
          key.id,
        );
        assert.deepEqual(rotated.grants, [personal, read]);
        await db
          .update(projectMemberships)
          .set({ role: "owner" })
          .where(eq(projectMemberships.id, membership!.id));
        const again = await service.authenticateScopedApiKey(
          db,
          rotated.rawKey,
        );
        assert.deepEqual(
          again.credential.kind === "api_key" && again.credential.grants,
          [personal, read],
          "Rotation cannot resurrect removed rights",
        );
        await db
          .update(projectMemberships)
          .set({ removedAt: new Date() })
          .where(eq(projectMemberships.id, membership!.id));
        const removed = await service.authenticateScopedApiKey(
          db,
          rotated.rawKey,
        );
        assert.deepEqual(
          removed.credential.kind === "api_key" && removed.credential.grants,
          [personal],
        );
        await assert.rejects(issue([read]), AuthorizationError);
        await db
          .update(projectMemberships)
          .set({ removedAt: null })
          .where(eq(projectMemberships.id, membership!.id));
      },
    );

    await t.test(
      "session refresh/revoke and principal disable are checked on every mutation",
      async () => {
        const key = await issue([read], year);
        await db
          .update(authUsers)
          .set({ status: "disabled" })
          .where(eq(authUsers.id, owner.user.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, key.rawKey),
          AuthenticationError,
        );
        await assert.rejects(issue([read]), AuthenticationError);
        await db
          .update(authUsers)
          .set({ status: "active" })
          .where(eq(authUsers.id, owner.user.id));
        await db
          .update(authActors)
          .set({ status: "disabled" })
          .where(eq(authActors.id, owner.actor.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, key.rawKey),
          AuthenticationError,
        );
        await db
          .update(authActors)
          .set({ status: "active" })
          .where(eq(authActors.id, owner.actor.id));
        await db
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(eq(authSessions.id, owner.session.id));
        await assert.rejects(issue([read]), AuthenticationError);
        await db
          .update(authSessions)
          .set({ revokedAt: null })
          .where(eq(authSessions.id, owner.session.id));
        await db
          .update(authSessions)
          .set({
            createdAt: new Date(Date.now() - 120_000),
            idleExpiresAt: new Date(Date.now() - 60_000),
          })
          .where(eq(authSessions.id, owner.session.id));
        await assert.rejects(issue([read]), AuthenticationError);
        await db
          .update(authSessions)
          .set({
            idleExpiresAt: owner.session.idleExpiresAt,
            createdAt: owner.session.createdAt,
          })
          .where(eq(authSessions.id, owner.session.id));
        await db
          .update(apiKeys)
          .set({
            createdAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() - 1000),
          })
          .where(eq(apiKeys.id, key.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, key.rawKey),
          AuthenticationError,
        );
        await assert.rejects(
          service.authenticateScopedApiKey(db, "tw_invalid"),
          AuthenticationError,
        );
      },
    );

    await t.test(
      "managed agents retain type and enforce manager/account and membership boundaries",
      async () => {
        const [agent] = await db
          .insert(authActors)
          .values({
            type: "agent",
            displayName: "Key agent",
            managedByActorId: owner.actor.id,
            managedByActorType: "human",
            status: "active",
          })
          .returning();
        await db.insert(projectMemberships).values({
          projectId: project!.id,
          actorId: agent!.id,
          actorType: "agent",
          role: "member",
          explicitPermissions: ["execution.run"],
        });
        const agentGrants: AuthorizationGrant[] = [
          { ...read, permissions: ["resource.read", "execution.run"] },
        ];
        const key = await service.issueScopedApiKey(
          db,
          owner.context,
          agent!.id,
          { name: "Agent key", grants: agentGrants, expiresAt: null },
        );
        const agentContext = await service.authenticateScopedApiKey(
          db,
          key.rawKey,
        );
        assert.equal(agentContext.actor.id, agent!.id);
        assert.equal(agentContext.actor.type, "agent");
        await assert.rejects(
          service.issueScopedApiKey(db, owner.context, agent!.id, {
            name: "Agent personal read",
            grants: [
              {
                scope: "personal",
                actorId: agent!.id,
                permissions: ["resource.read"],
              },
            ],
            expiresAt: null,
          }),
          AuthorizationError,
        );
        await assert.rejects(
          service.issueScopedApiKey(db, other.context, agent!.id, {
            name: "Other manager",
            grants: agentGrants,
            expiresAt: null,
          }),
          AuthorizationError,
        );
        await db
          .update(authUsers)
          .set({ status: "disabled" })
          .where(eq(authUsers.id, owner.user.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, key.rawKey),
          AuthenticationError,
        );
        await db
          .update(authUsers)
          .set({ status: "active" })
          .where(eq(authUsers.id, owner.user.id));
        await db
          .update(authActors)
          .set({ status: "disabled" })
          .where(eq(authActors.id, agent!.id));
        assert.ok(
          (await service.listScopedApiKeys(db, owner.context, agent!.id)).some(
            (listed) => listed.id === key.id,
          ),
        );
        await service.revokeScopedApiKey(db, owner.context, key.id);
        await db
          .update(authActors)
          .set({ status: "active" })
          .where(eq(authActors.id, agent!.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, key.rawKey),
          AuthenticationError,
        );
      },
    );

    await t.test(
      "persisted explicit rights and project archival are live ceilings",
      async () => {
        await db
          .update(projectMemberships)
          .set({ explicitPermissions: ["execution.review"] })
          .where(eq(projectMemberships.id, membership!.id));
        const reviewKey = await issue([
          { ...read, permissions: ["execution.review"] },
        ]);
        await service.authenticateScopedApiKey(db, reviewKey.rawKey);
        await db
          .update(projectMemberships)
          .set({ explicitPermissions: [] })
          .where(eq(projectMemberships.id, membership!.id));
        await assert.rejects(
          service.authenticateScopedApiKey(db, reviewKey.rawKey),
          AuthorizationError,
        );
        const projectKey = await issue([personal, read]);
        await db
          .update(projects)
          .set({ status: "archived" })
          .where(eq(projects.id, project!.id));
        const archived = await service.authenticateScopedApiKey(
          db,
          projectKey.rawKey,
        );
        assert.deepEqual(
          archived.credential.kind === "api_key" && archived.credential.grants,
          [personal],
        );
        await assert.rejects(issue([read]), AuthorizationError);
        await db
          .update(projects)
          .set({ status: "active" })
          .where(eq(projects.id, project!.id));
      },
    );

    await t.test(
      "bound storage rejects incomplete identity, malformed hash and duplicate material",
      async () => {
        await assert.rejects(
          db.insert(apiKeys).values({
            name: "Partial",
            keyHash: "a".repeat(64),
            keyPrefix: "tw_partial",
            actorId: owner.actor.id,
          }),
        );
        await assert.rejects(
          db.insert(apiKeys).values({
            name: "Empty grants",
            keyHash: "c".repeat(64),
            keyPrefix: "tw_empty",
            actorId: owner.actor.id,
            issuedByActorId: owner.actor.id,
            grants: [],
          }),
        );
        await assert.rejects(
          db.insert(apiKeys).values({
            name: "Invalid subject",
            keyHash: "d".repeat(64),
            keyPrefix: "tw_invalid",
            actorId: randomUUID(),
            issuedByActorId: owner.actor.id,
            grants: [read],
          }),
        );
        const [stored] = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, root.id));
        await assert.rejects(
          db.insert(apiKeys).values({
            name: "Duplicate hash",
            keyHash: stored!.keyHash,
            keyPrefix: "tw_duplicate",
            actorId: owner.actor.id,
            issuedByActorId: owner.actor.id,
            grants: [read],
          }),
        );
      },
    );

    await t.test(
      "legacy compatibility never leaks hashes or downgrades scoped credentials",
      async () => {
        const legacy = await service.createApiKey(db, {
          name: "Legacy compatibility",
        });
        assert.ok(!("keyHash" in legacy));
        assert.ok(await service.validateApiKey(db, legacy.rawKey));
        await assert.rejects(
          service.authenticateScopedApiKey(db, legacy.rawKey),
          AuthenticationError,
        );
        const rotated = await service.rotateApiKey(db, legacy.id);
        assert.ok(!("keyHash" in rotated));
        assert.equal(await service.validateApiKey(db, legacy.rawKey), null);
        const deleted = await service.revokeApiKey(db, rotated.id);
        assert.ok(!("keyHash" in deleted));
        assert.equal(await service.validateApiKey(db, rotated.rawKey), null);
        assert.ok(
          (
            await db.select().from(apiKeys).where(eq(apiKeys.id, rotated.id))
          )[0]!.revokedAt,
        );
        const listed = await service.listApiKeys(db);
        assert.ok(
          listed.every((key) => !("keyHash" in key) && !("rawKey" in key)),
        );
        assert.ok(
          !listed.some(
            (key) =>
              key.id === root.id ||
              key.id === legacy.id ||
              key.id === rotated.id,
          ),
        );
      },
    );
  },
);
