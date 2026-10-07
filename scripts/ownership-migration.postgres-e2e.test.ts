import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, projects, documents, daemons, apiKeys, requirements, requirementClaims, taskClaims, tasks, tiAgentRuns, tiAgentPolicies, tiAgentModelConfigs, repositoryCheckoutBindings, repositories, authMigrationReceipts, projectMemberships } = require("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, inspectOwnershipMigration, applyOwnershipMigration } = require("@task-weaver/core");
const { eq } = require("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("offline ownership migration is explicit, restricted, atomic and replay-safe", { skip: !databaseUrl, timeout: 150000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  await db.update(authInstanceState).set({ initializedByUserId: null, initializedAt: null }).where(eq(authInstanceState.id, "instance"));
  const config = { secret: randomBytes(32).toString("hex"), bootstrapSecret: randomBytes(32).toString("hex"), baseURL: "http://127.0.0.1:3001", trustedOrigins: ["http://127.0.0.1:3000"] };
  const runtime = createAuthenticationRuntime(db, config);
  const password = randomBytes(24).toString("hex");
  function csrf() {
    const c = runtime.authentication.csrfChallenge();
    return new Headers({ origin: config.trustedOrigins[0], "x-csrf-token": c.csrfToken, cookie: c.headers.getSetCookie().map((x: string) => x.split(";")[0]).join("; ") });
  }
  async function login(email: string) {
    const headers = csrf();
    const response = await runtime.authentication.login(headers, { email, password }, randomUUID());
    headers.set("cookie", [headers.get("cookie"), ...response.headers.getSetCookie().map((x: string) => x.split(";")[0])].join("; "));
    const context = await runtime.verify(headers);
    return { headers, context, service: createResourceServices(context) };
  }
  const email = `${randomUUID()}@example.test`;
  await runtime.authentication.bootstrap(csrf(), { email, displayName: "Migration operator", password, bootstrapSecret: config.bootstrapSecret }, randomUUID());
  const admin = await login(email);
  async function human() {
    const email = `${randomUUID()}@example.test`;
    const invitation = await runtime.authentication.provision(admin.headers, { email, displayName: "Mapped human" });
    await runtime.authentication.activate(csrf(), { token: invitation.activationToken, password }, randomUUID());
    return login(email);
  }
  const owner = await human(), stranger = await human();
  const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Fresh executor" });
  const [project] = await db.insert(projects).values({ name: "Unowned legacy project", createdBy: "anonymous" }).returning();
  const [requirement] = await db.insert(requirements).values({ projectId: project.id, title: "Legacy lane", createdBy: "tw-cli", leaseGeneration: 7 }).returning();
  const [task] = await db.insert(tasks).values({ projectId: project.id, requirementId: requirement.id, title: "Legacy task", createdBy: "anonymous" }).returning();
  const [privateDoc] = await db.insert(documents).values({ title: "Private legacy note", content: "migration-content-canary", createdBy: "apikey:legacy", personalOwnerId: "apikey:legacy", personalOwnerType: "agent" }).returning();
  const [unowned] = await db.insert(documents).values({ title: "Unknown note", content: "migration-content-canary", createdBy: "anonymous" }).returning();
  const [approvedGlobal] = await db.insert(documents).values({ title: "Approved global note", content: "Public fixture", createdBy: "tw-cli" }).returning();
  const [daemon] = await db.insert(daemons).values({ name: "Legacy active runner", actorId: "tw-cli", actorType: "agent", status: "busy", activeTaskIds: [task.id], capabilities: ["codex"] }).returning();
  await db.insert(requirementClaims).values({ requirementId: requirement.id, claimedBy: "tw-cli", claimedByType: "agent", daemonId: daemon.id, generation: 7, expiresAt: new Date(Date.now() + 600000) });
  await db.insert(taskClaims).values({ taskId: task.id, claimedBy: "tw-cli", claimedByType: "agent", expiresAt: new Date(Date.now() + 600000) });
  const [key] = await db.insert(apiKeys).values({ name: "Legacy key", keyHash: "a".repeat(64), keyPrefix: "tw_legacy" }).returning();
  const [run] = await db.insert(tiAgentRuns).values({ taskId: task.id, createdBy: "apikey:legacy", status: "running", leaseOwnerId: "tw-cli", leaseOwnerType: "agent", leaseExpiresAt: new Date(Date.now() + 600000) }).returning();
  await db.insert(tiAgentPolicies).values({ ownerId: "apikey:legacy", ownerType: "agent", enabled: true, executionMode: "live" });
  const [legacyModel] = await db.insert(tiAgentModelConfigs).values({ ownerId: "apikey:legacy", ownerType: "agent", provider: "fixture", model: "fixture", credentialStatus: "valid", apiKeyRef: "migration-secret-canary", availabilityCheckedAt: new Date() }).returning();
  const [currentModel] = await db.insert(tiAgentModelConfigs).values({ ownerId: owner.context.actor.id, ownerType: "human", provider: "fixture", model: "fixture" }).returning();
  const [repo] = await db.insert(repositories).values({ displayName: "Legacy repository", provider: "github", host: "github.com", namespace: "fixture", name: randomUUID(), canonicalKey: randomUUID(), createdBy: "anonymous" }).returning();
  await db.insert(repositoryCheckoutBindings).values({ repositoryId: repo.id, nodeId: "legacy", checkoutPath: "/private/migration-path-canary", lastVerifiedAt: new Date() });
  const [legacyUuidDoc] = await db.insert(documents).values({ title: "Legacy UUID label", content: "migration-content-canary", createdBy: "tw-cli", personalOwnerId: owner.context.actor.id, personalOwnerType: "human" }).returning();
  const legacyBefore = new Date().toISOString();
  await db.update(tiAgentModelConfigs).set({ createdAt: new Date(Date.parse(legacyBefore) + 1000) }).where(eq(tiAgentModelConfigs.id, currentModel.id));
  const [freshDoc] = await db.insert(documents).values({ title: "New authenticated note", content: "Private fixture", createdBy: owner.context.actor.id, personalOwnerId: owner.context.actor.id, personalOwnerType: "human", createdAt: new Date(Date.parse(legacyBefore) + 1000) }).returning();
  let before: any;
  let manifest: any;
  await t.test("offline command rejects unacknowledged writes without disclosing configuration", async () => {
    const result = spawnSync("pnpm", ["exec", "tsx", fileURLToPath(new URL("./auth-ownership-migration.mts", import.meta.url)), "--apply"], { encoding: "utf8", timeout: 15000, env: { ...process.env, TW_AUTH_MIGRATION_DATABASE_URL: "postgres://fixture:command-secret-canary@127.0.0.1:1/unused" } });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Ownership migration failed"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes("command-secret-canary"));
  });
  await t.test("inventory is deterministic, read-only and secret-free", async () => {
    before = await inspectOwnershipMigration(db, legacyBefore);
    assert.deepEqual(await inspectOwnershipMigration(db, legacyBefore), before);
    for (const secret of ["migration-content-canary", "migration-secret-canary", "migration-path-canary", "apikey:legacy", "tw-cli", "a".repeat(64)]) assert.ok(!JSON.stringify(before).includes(secret));
    const mapping = (resource: string, id: string, actorId: string) => ({ resource, id, actorId, ownerFingerprint: before.rows.find((row: any) => row.resource === resource && row.id === id).ownerFingerprint });
    manifest = { id: randomUUID(), legacyBefore, ownership: [mapping("documents", privateDoc.id, owner.context.actor.id), mapping("daemons", daemon.id, agent.id)], memberships: [{ projectId: project.id, actorId: owner.context.actor.id, role: "owner", explicitPermissions: [] }] };
    const preview = await applyOwnershipMigration(db, manifest, before.fingerprint, true);
    assert.equal(preview.dryRun, true);
    assert.equal((await inspectOwnershipMigration(db, legacyBefore)).fingerprint, before.fingerprint);
    assert.equal((await db.select().from(authMigrationReceipts).where(eq(authMigrationReceipts.id, manifest.id))).length, 0);
  });
  await t.test("invalid targets, stale inventory and contradictory mappings commit nothing", async () => {
    await assert.rejects(applyOwnershipMigration(db, manifest, "0".repeat(64)));
    await assert.rejects(applyOwnershipMigration(db, { ...manifest, ownership: [{ ...manifest.ownership[0], actorId: agent.id }] }, before.fingerprint));
    await assert.rejects(applyOwnershipMigration(db, { ...manifest, ownership: [...manifest.ownership, manifest.ownership[0]] }, before.fingerprint));
    await assert.rejects(applyOwnershipMigration(db, { ...manifest, memberships: [{ ...manifest.memberships[0], role: "member" }] }, before.fingerprint));
    const modelRow = before.rows.find((row: any) => row.resource === "tiAgentModelConfigs" && row.id === legacyModel.id);
    await assert.rejects(applyOwnershipMigration(db, { ...manifest, ownership: [...manifest.ownership, { resource: "tiAgentModelConfigs", id: legacyModel.id, ownerFingerprint: modelRow.ownerFingerprint, actorId: owner.context.actor.id }] }, before.fingerprint));
    assert.equal((await inspectOwnershipMigration(db, legacyBefore)).fingerprint, before.fingerprint);
    assert.equal((await db.select().from(documents).where(eq(documents.id, privateDoc.id)))[0].personalOwnerId, "apikey:legacy");
  });
  await t.test("explicit ownership restores only the approved human and project", async () => {
    const result = await applyOwnershipMigration(db, manifest, before.fingerprint);
    assert.equal(result.mapped, 2);
    assert.ok(result.quarantined > 0);
    assert.equal((await owner.service.documentService.getDocument(db, privateDoc.id)).createdBy, "apikey:legacy");
    for (const user of [admin, stranger]) await assert.rejects(user.service.documentService.getDocument(db, privateDoc.id));
    for (const user of [owner, admin, stranger]) {
      await assert.rejects(user.service.documentService.getDocument(db, unowned.id));
      await assert.rejects(user.service.documentService.getDocument(db, legacyUuidDoc.id));
    }
    assert.equal((await owner.service.documentService.getDocument(db, freshDoc.id)).id, freshDoc.id);
    assert.equal((await owner.service.projectService.getProject(db, project.id)).id, project.id);
    await assert.rejects(admin.service.projectService.getProject(db, project.id));
    await assert.rejects(stranger.service.projectService.getProject(db, project.id));
    await assert.rejects(stranger.service.documentService.getDocument(db, approvedGlobal.id));
    assert.equal((await db.select().from(projects).where(eq(projects.id, project.id)))[0].createdBy, "anonymous");
    assert.ok((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0].revokedAt);
  });
  await t.test("old runtime authority and readiness are fenced without erasing historical identity", async () => {
    assert.equal((await db.select().from(requirementClaims)).length, 0);
    assert.equal((await db.select().from(taskClaims)).length, 0);
    assert.equal((await db.select().from(requirements).where(eq(requirements.id, requirement.id)))[0].leaseGeneration, 8);
    const migratedDaemon = (await db.select().from(daemons).where(eq(daemons.id, daemon.id)))[0];
    assert.equal(migratedDaemon.actorId, agent.id);
    assert.equal(migratedDaemon.status, "offline");
    assert.deepEqual(migratedDaemon.activeTaskIds, []);
    const migratedRun = (await db.select().from(tiAgentRuns).where(eq(tiAgentRuns.id, run.id)))[0];
    assert.equal(migratedRun.status, "cancelled");
    assert.equal(migratedRun.createdBy, "apikey:legacy");
    assert.equal(migratedRun.leaseOwnerId, null);
    assert.ok((await db.select().from(tiAgentPolicies)).every((row: any) => !row.enabled));
    assert.ok((await db.select().from(tiAgentModelConfigs)).every((row: any) => row.credentialStatus === "unknown"));
    assert.ok((await db.select().from(repositoryCheckoutBindings)).every((row: any) => !row.lastVerifiedAt));
  });
  await t.test("same receipt replay cannot revoke a fresh session, key or lease", async () => {
    const fresh = await runtime.identity.issueKey(owner.headers, owner.context.actor.id, { name: "Explicit replacement", expiresAt: null, grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }] });
    assert.equal((await runtime.verify(new Headers({ authorization: `Bearer ${fresh.rawKey}` }))).actor.id, owner.context.actor.id);
    await db.insert(requirementClaims).values({ requirementId: requirement.id, claimedBy: agent.id, claimedByType: "agent", generation: 9, expiresAt: new Date(Date.now() + 600000) });
    assert.equal((await applyOwnershipMigration(db, manifest, before.fingerprint)).replayed, true);
    assert.equal((await db.select().from(requirementClaims).where(eq(requirementClaims.requirementId, requirement.id))).length, 1);
    assert.equal((await runtime.verify(owner.headers)).actor.id, owner.context.actor.id);
    await assert.rejects(applyOwnershipMigration(db, { ...manifest, ownership: [] }, before.fingerprint));
  });
});
