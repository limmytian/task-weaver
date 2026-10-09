import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, projects, requirements, tasks, documents, daemons, requirementClaims, tiAgentRuns, tiAgentModelConfigs, tiAgentPolicies, authActors, projectMemberships, apiKeys, authSessions } = require("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, inspectOwnershipMigration, applyOwnershipMigration, createTiExecutionService } = require("@task-weaver/core");
const { eq, sql } = require("drizzle-orm");
const { migrate } = require("drizzle-orm/postgres-js/migrator");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("sanitized exact-0.3.2 upgrade and constrained recovery rehearsal", { skip: !databaseUrl, timeout: 150000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
  const container = process.env.TW_AUTH_E2E_CONTAINER!;
  assert.match(container, /^tw-auth-e2e-[a-f0-9-]+$/);
  // Prove that the destructive rehearsal targets the runner's disposable container and port.
  const instance = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0];
  assert.equal(instance.HostConfig.AutoRemove, true);
  assert.equal(instance.Config.Env.includes("POSTGRES_DB=tw_auth_e2e"), true);
  assert.equal(instance.Config.Env.includes("POSTGRES_USER=fixture"), true);
  assert.equal(instance.NetworkSettings.Ports["5432/tcp"][0].HostIp, "127.0.0.1");
  assert.equal(instance.NetworkSettings.Ports["5432/tcp"][0].HostPort, url.port);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const folder = await mkdtemp(join(tmpdir(), "tw-upgrade-rehearsal-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const pinned = JSON.parse(await readFile(new URL("./fixtures/upgrade-0.3.2-migrations.json", import.meta.url), "utf8"));
  await cp(fileURLToPath(new URL("../packages/db/drizzle/", import.meta.url)), folder, { recursive: true });
  await t.test("fixture schema matches the immutable public 0.3.2 journal and SQL bytes", async () => {
    assert.equal(pinned.commit, "556ba6373bb1f4a128455f008d07d53725495c20");
    assert.equal(pinned.journal.entries.length, 48);
    for (const [name, hash] of Object.entries(pinned.sha256)) assert.equal(createHash("sha256").update(await readFile(join(folder, name))).digest("hex"), hash);
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(pinned.journal));
    await db.execute(sql`DROP SCHEMA IF EXISTS task_weaver CASCADE`);
    await db.execute(sql`CREATE SCHEMA task_weaver`);
    await migrate(db, { migrationsFolder: folder, migrationsSchema: "task_weaver", migrationsTable: "__drizzle_migrations" });
  });
  // Seed the pinned legacy schema without referencing columns introduced by later migrations.
  const [project] = await db.execute<{ id: string }>(sql`INSERT INTO task_weaver.projects (name, created_by) VALUES ('Sanitized legacy A', 'tw-cli') RETURNING id`);
  const [other] = await db.execute<{ id: string }>(sql`INSERT INTO task_weaver.projects (name, created_by) VALUES ('Sanitized legacy B', 'anonymous') RETURNING id`);
  const [requirement] = await db.insert(requirements).values({ projectId: project.id, title: "Recover lane", status: "approved", leaseGeneration: 5, createdBy: "tw-cli" }).returning();
  const [task] = await db.insert(tasks).values({ projectId: project.id, requirementId: requirement.id, title: "Recover task", tags: ["capability:tw-v0.3.3-development"], createdBy: "apikey:synthetic" }).returning();
  const [privateDoc] = await db.insert(documents).values({ title: "Sanitized private note", content: "Synthetic fixture only", personalOwnerId: "apikey:synthetic", personalOwnerType: "agent", createdBy: "apikey:synthetic" }).returning();
  const [unknownDoc] = await db.insert(documents).values({ title: "Unmapped note", content: "Synthetic fixture only", createdBy: "anonymous" }).returning();
  const [active] = await db.insert(daemons).values({ name: "Old active fixture", actorId: "tw-cli", actorType: "agent", status: "busy", activeTaskIds: [task.id], capabilities: ["codex"], lastHeartbeatAt: new Date() }).returning();
  const [inactive] = await db.insert(daemons).values({ name: "Old inactive fixture", actorId: "tw-cli", actorType: "agent", status: "offline", lastHeartbeatAt: new Date(0) }).returning();
  await db.insert(requirementClaims).values({ requirementId: requirement.id, claimedBy: "tw-cli", claimedByType: "agent", daemonId: active.id, workerIndex: "0", generation: 5, expiresAt: new Date(Date.now() + 600000) });
  // Pre-upgrade columns are explicit because current Drizzle metadata includes later auth fields.
  const legacyToken = `tw_${randomBytes(32).toString("hex")}`;
  await db.execute(sql`INSERT INTO task_weaver.api_keys (name, key_hash, key_prefix) VALUES ('Synthetic legacy key', ${createHash("sha256").update(legacyToken).digest("hex")}, 'tw_fixture')`);
  await db.execute(sql`INSERT INTO task_weaver.ti_agent_runs (task_id, status, created_by, lease_owner_id, lease_owner_type, lease_expires_at) VALUES (${task.id}, 'running', 'apikey:synthetic', 'tw-cli', 'agent', now() + interval '10 minutes')`);
  const [legacyModel] = await db.insert(tiAgentModelConfigs).values({ ownerId: "apikey:synthetic", ownerType: "agent", provider: "fixture", model: "safe", credentialStatus: "valid", isDefaultAgent: true }).returning();
  const [legacyPolicy] = await db.insert(tiAgentPolicies).values({ ownerId: "apikey:synthetic", ownerType: "agent", enabled: true, executionMode: "live" }).returning();
  // Use the database clock and round up: PostgreSQL timestamps retain sub-millisecond precision.
  const [boundary] = await db.select({ cutoff: sql`date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond'` }).from(tiAgentPolicies).where(eq(tiAgentPolicies.id, legacyPolicy.id));
  const cutoff = new Date(boundary.cutoff).toISOString();
  // The full database dump exists only in test memory and contains synthetic fixtures, never a real database.
  const backup = execFileSync("docker", ["exec", container, "pg_dump", "-U", "fixture", "-d", "tw_auth_e2e", "--clean", "--if-exists"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.ok(backup.includes("Sanitized legacy A"));
  await t.test("schema upgrade repeats without manufacturing actors or memberships", async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    assert.equal((await db.select().from(authActors)).length, 0);
    assert.equal((await db.select().from(projectMemberships)).length, 0);
    assert.equal((await db.select().from(projects).where(eq(projects.id, project.id)))[0].createdBy, "tw-cli");
  });
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
    return { headers, context, actor: { id: context.actor.id, type: context.actor.type }, service: createResourceServices(context) };
  }
  const adminEmail = `${randomUUID()}@example.test`;
  await runtime.authentication.bootstrap(csrf(), { email: adminEmail, displayName: "Upgrade admin", password, bootstrapSecret: config.bootstrapSecret }, randomUUID());
  const admin = await login(adminEmail);
  async function human() {
    const email = `${randomUUID()}@example.test`;
    const invitation = await runtime.authentication.provision(admin.headers, { email, displayName: "Upgrade human" });
    await runtime.authentication.activate(csrf(), { token: invitation.activationToken, password }, randomUUID());
    return login(email);
  }
  const owner = await human(), stranger = await human();
  const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Recovered executor" });
  const before = await inspectOwnershipMigration(db, cutoff);
  for (const id of [legacyModel.id, legacyPolicy.id]) {
    assert.ok(before.rows.some((row: any) => row.id === id), "Legacy model and policy must be inside the fixture cutoff");
  }
  const ownership = before.rows.filter((row: any) => [privateDoc.id, active.id, inactive.id].includes(row.id) || ["tiAgentModelConfigs", "tiAgentPolicies"].includes(row.resource)).map((row: any) => ({ resource: row.resource, id: row.id, ownerFingerprint: row.ownerFingerprint, actorId: row.resource === "daemons" ? agent.id : owner.actor.id }));
  const manifest = { id: randomUUID(), legacyBefore: cutoff, ownership, memberships: [
    { projectId: project.id, actorId: owner.actor.id, role: "owner", explicitPermissions: ["execution.run"] },
    { projectId: project.id, actorId: agent.id, role: "member", explicitPermissions: ["execution.run"] },
    { projectId: other.id, actorId: stranger.actor.id, role: "owner", explicitPermissions: [] },
  ] };
  await applyOwnershipMigration(db, manifest, before.fingerprint);
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  async function call(path: string, headers: Headers, body?: unknown, method = "POST") {
    const response = await app.request(`/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  let executor: any;
  let lane: any;
  let child: any;
  await t.test("mandatory authentication, explicit replacement keys and migrated data preserve isolation", async () => {
    assert.equal((await call("projects", new Headers(), undefined, "GET")).status, 401);
    assert.equal((await call("projects", new Headers({ authorization: `Bearer ${legacyToken}`, "x-actor-id": owner.actor.id }), undefined, "GET")).status, 401);
    assert.equal((await owner.service.documentService.getDocument(db, privateDoc.id)).createdBy, "apikey:synthetic");
    await assert.rejects(stranger.service.documentService.getDocument(db, privateDoc.id));
    await assert.rejects(admin.service.documentService.getDocument(db, privateDoc.id));
    await assert.rejects(owner.service.documentService.getDocument(db, unknownDoc.id));
    await assert.rejects(owner.service.projectService.getProject(db, other.id));
    await assert.rejects(admin.service.projectService.getProject(db, project.id));
    const read = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Scoped replacement", expiresAt: null, grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }] });
    const bounded = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${read.rawKey}` })));
    assert.equal((await bounded.projectService.getProject(db, project.id)).id, project.id);
    await assert.rejects(bounded.projectService.getProject(db, other.id));
    await assert.rejects(bounded.documentService.getDocument(db, privateDoc.id));
    await db.update(apiKeys).set({ createdAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, read.id));
    await assert.rejects(runtime.verify(new Headers({ authorization: `Bearer ${read.rawKey}` })));
    const personalKey = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Human personal replacement", expiresAt: null, grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write"] }] });
    const personalContext = await runtime.verify(new Headers({ authorization: `Bearer ${personalKey.rawKey}` }));
    const personal = await createResourceServices(personalContext).documentService.createDocument(db, { title: "Human-owned post-upgrade note", content: "Synthetic fixture only", personalOwnerId: owner.actor.id, personalOwnerType: "human" }, owner.actor);
    assert.equal(personal.personalOwnerId, owner.actor.id);
    assert.equal(personal.personalOwnerType, "human");
    const issued = await runtime.identity.issueKey(owner.headers, agent.id, { name: "Recovered supervisor", expiresAt: null, grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "resource.write", "execution.run"] }] });
    const headers = new Headers({ authorization: `Bearer ${issued.rawKey}` });
    const context = await runtime.verify(headers);
    executor = { headers, context, actor: { id: agent.id, type: "agent" }, issued, service: createResourceServices(context) };
  });
  await t.test("active and inactive legacy daemons require fresh registration and explicit resume", async () => {
    for (const daemon of [active, inactive]) {
      const registration = await call("daemons/register", executor.headers, { id: daemon.id, name: "Recovered fixture", role: "executor", processStartedAt: new Date().toISOString(), capabilities: ["codex", "tw-v0.3.3-development"], workerCapacity: 4 });
      assert.equal(registration.status, 201, JSON.stringify(registration.body));
      assert.equal((await call(`daemons/${daemon.id}/status`, executor.headers, { status: "idle", activeTaskIds: [] })).status, 200);
      const paused = await call(`daemons/${daemon.id}/apply-requirement`, executor.headers, { projectId: project.id, workerIndex: 0 });
      assert.equal(paused.body.requirement, null);
      assert.equal((await call(`daemons/${daemon.id}/control`, owner.headers, { action: "resume", reason: "Explicit disposable recovery" })).status, 200);
    }
    const result = await call(`daemons/${active.id}/apply-requirement`, executor.headers, { projectId: project.id, workerIndex: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.requirement.id, requirement.id);
    assert.ok(result.body.leaseGeneration > 5);
    lane = result.body;
    const oldProgress = await call(`daemons/${active.id}/progress`, executor.headers, { eventId: randomUUID(), runId: randomUUID(), workerIndex: 0, requirementId: requirement.id, currentTaskId: task.id, phase: "executing", workspaceState: "clean", source: "daemon", leaseGeneration: 5, details: {} });
    assert.notEqual(oldProgress.status, 200);
    const issued = await call(`daemons/${active.id}/delegations`, executor.headers, { requirementId: requirement.id, runId: lane.runId, workerIndex: 0, leaseGeneration: lane.leaseGeneration, taskId: task.id });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    child = issued.body;
    assert.equal((await createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${child.token}` }))).taskService.getTask(db, task.id)).id, task.id);
  });
  await t.test("expired recovered leases invalidate children and reacquire with a new fence", async () => {
    await db.update(requirementClaims).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(requirementClaims.requirementId, requirement.id));
    await assert.rejects(runtime.verify(new Headers({ authorization: `Bearer ${child.token}` })));
    const blocked = await call(`daemons/${active.id}/apply-requirement`, executor.headers, { projectId: project.id, workerIndex: 0 });
    assert.equal(blocked.body.requirement, null, "Interrupted in-progress work is not silently resumed");
    const recovery = await executor.service.claimService.claimRequirement(db, requirement.id, executor.actor, 2, { daemonId: active.id, workerIndex: 0 });
    const reconciled = await call(`daemons/${active.id}/reconcile`, executor.headers, { runId: recovery.id, workerIndex: 0, requirementId: requirement.id, leaseGeneration: recovery.generation, reason: "Explicit clean disposable recovery", workspaceState: "clean" });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    await executor.service.claimService.releaseRequirement(db, requirement.id, executor.actor, "Reconciliation complete", active.id, recovery.generation);
    const result = await call(`daemons/${active.id}/apply-requirement`, executor.headers, { projectId: project.id, workerIndex: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.requirement.id, requirement.id);
    assert.ok(result.body.leaseGeneration > lane.leaseGeneration);
    await assert.rejects(executor.service.claimService.releaseRequirement(db, requirement.id, executor.actor, "Old fence", active.id, lane.leaseGeneration));
    assert.equal((await applyOwnershipMigration(db, manifest, before.fingerprint)).replayed, true);
    assert.equal((await db.select().from(requirementClaims).where(eq(requirementClaims.requirementId, requirement.id)))[0].generation, result.body.leaseGeneration);
  });
  await t.test("workspace recovery preserves dirty diffs and quarantines conflicted or missing state", async () => {
    for (const [index, workspaceState] of ["dirty", "conflicted", "missing"].entries()) {
      const req = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: `${workspaceState} recovery`, status: "approved" }, owner.actor);
      const work = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: req.id, title: "Pending diff" }, owner.actor);
      const workerIndex = index + 1;
      const claim = await executor.service.claimService.claimRequirement(db, req.id, executor.actor, 2, { daemonId: active.id, workerIndex });
      await executor.service.taskService.updateTaskStatus(db, work.id, "in_progress", executor.actor, "Disposable interrupted work", false, { daemonId: active.id, leaseGeneration: claim.generation });
      const result = await call(`daemons/${active.id}/reconcile`, executor.headers, { runId: claim.id, workerIndex, requirementId: req.id, leaseGeneration: claim.generation, reason: "Explicit disposable workspace recovery", workspaceState, pendingDiffSummary: "Synthetic unreviewed changes" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.recoveryDisposition, workspaceState === "dirty" ? "resume" : "quarantine");
      assert.equal(result.body.progress.pendingDiffSummary, "Synthetic unreviewed changes");
      assert.equal((await owner.service.taskService.getTask(db, work.id)).status, workspaceState === "dirty" ? "todo" : "in_review");
      await executor.service.claimService.releaseRequirement(db, req.id, executor.actor, "Recovery recorded without execution", active.id, claim.generation);
    }
  });
  await t.test("Ti requires new policy authorization, current task capability and fresh executor fence", async () => {
    assert.equal((await db.select().from(tiAgentRuns))[0].status, "cancelled");
    const req = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Fresh Ti recovery", status: "approved" }, owner.actor);
    const tiTask = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: req.id, title: "Assigned fresh Ti", assignee: agent.id, assigneeType: "agent" }, owner.actor);
    const create = () => owner.service.tiAgentService.createRun(db, { taskId: tiTask.id, assignedAgentId: agent.id, assignedAgentType: "agent" }, owner.actor);
    await assert.rejects(create());
    // Explicit disposable policy/model revalidation; no provider or worker process is launched.
    await db.update(tiAgentPolicies).set({ enabled: true, executionMode: "dry_run" }).where(eq(tiAgentPolicies.ownerId, owner.actor.id));
    await db.update(tiAgentModelConfigs).set({ credentialStatus: "valid" }).where(eq(tiAgentModelConfigs.ownerId, owner.actor.id));
    const run = await create();
    const worker = { assignedAgentId: agent.id, workerId: "upgrade-fixture", durationMinutes: 15 };
    const acquired = await executor.service.tiAgentService.acquireRun(db, worker, executor.actor);
    assert.equal(acquired.id, run.id);
    const supervisor = createTiExecutionService(executor.context);
    const fence = { workerId: worker.workerId, leaseGeneration: acquired.leaseGeneration };
    const token = await supervisor.issueDelegation(db, run.id, fence);
    const bound = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${token.token}` })));
    assert.equal((await bound.taskService.getTask(db, tiTask.id)).id, tiTask.id);
    await assert.rejects(bound.taskService.getTask(db, task.id));
    await supervisor.invoke(db, "completeRun", [run.id, { ...fence, status: "succeeded" }]);
    await assert.rejects(runtime.verify(new Headers({ authorization: `Bearer ${token.token}` })));
  });
  await t.test("revocation survives recovery and no old identity resumes from headers", async () => {
    await runtime.identity.revokeKey(owner.headers, agent.id, executor.issued.id);
    assert.equal((await call(`daemons/${active.id}/heartbeat`, executor.headers)).status, 401);
    await db.update(authSessions).set({ createdAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.id, stranger.context.credential.id));
    await assert.rejects(runtime.verify(stranger.headers));
    await runtime.authentication.logout(owner.headers);
    await assert.rejects(runtime.verify(owner.headers));
    const headers = new Headers({ "x-actor-id": owner.actor.id, "x-actor-type": "human" });
    assert.equal((await call("projects", headers, undefined, "GET")).status, 401);
  });
  await t.test("full pre-upgrade backup restore removes post-backup writes and can upgrade again", async () => {
    await db.execute(sql`DROP SCHEMA task_weaver CASCADE`);
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "fixture", "-d", "tw_auth_e2e", "-v", "ON_ERROR_STOP=1"], { input: backup, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    const state = await db.execute(sql`SELECT to_regclass('task_weaver.auth_actors') AS actors`);
    assert.equal(state[0].actors, null);
    assert.equal((await db.select({ id: projects.id }).from(projects)).length, 2);
    assert.equal((await db.select().from(requirements)).length, 1);
    assert.equal((await db.select().from(documents)).length, 2);
    assert.equal((await db.select().from(daemons).where(eq(daemons.id, active.id)))[0].actorId, "tw-cli");
    await runMigrations(databaseUrl!);
    assert.equal((await db.select().from(authActors)).length, 0);
    assert.equal((await db.select().from(projectMemberships)).length, 0);
    assert.equal((await db.select().from(apiKeys))[0].actorId, null);
  });
});
