import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, daemons, daemonWorkerProgress, apiKeys, requirements } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, apiKeyService } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("daemon authority scopes registration, queues and fenced operations", { skip: !databaseUrl, timeout: 150_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  // Bootstrap a fresh fixture instance without inheriting another suite's rate counter.
  await db.delete(authRateLimits).where(like(authRateLimits.id, "bootstrap:%"));
  await db.update(authInstanceState).set({ initializedByUserId: null, initializedAt: null }).where(eq(authInstanceState.id, "instance"));
  const config = {
    secret: randomBytes(32).toString("hex"), bootstrapSecret: randomBytes(32).toString("hex"),
    baseURL: "http://127.0.0.1:3001", trustedOrigins: ["http://127.0.0.1:3000"],
  };
  const runtime = createAuthenticationRuntime(db, config);
  const auth = runtime.authentication;
  const password = randomBytes(24).toString("hex");
  function csrf() {
    const challenge = auth.csrfChallenge();
    return new Headers({ origin: config.trustedOrigins[0], "x-csrf-token": challenge.csrfToken, cookie: challenge.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") });
  }
  async function login(email: string) {
    const headers = csrf();
    const result = await auth.login(headers, { email, password }, randomUUID());
    headers.set("cookie", [headers.get("cookie"), ...result.headers.getSetCookie().map((c: string) => c.split(";")[0])].join("; "));
    const context = await runtime.verify(headers);
    return { headers, context, actor: { id: context.actor.id, type: context.actor.type }, service: createResourceServices(context) };
  }
  const email = `${randomUUID()}@example.test`;
  await auth.bootstrap(csrf(), { email, displayName: "Admin fixture", password, bootstrapSecret: config.bootstrapSecret }, randomUUID());
  const admin = await login(email);
  async function human() {
    const email = `${randomUUID()}@example.test`;
    const invitation = await auth.provision(admin.headers, { email, displayName: "Resource fixture" });
    await auth.activate(csrf(), { token: invitation.activationToken, password }, randomUUID());
    return login(email);
  }
  const owner = await human(), outsider = await human();
  const project = await owner.service.projectService.createProject(db, { name: "Authorized work" }, owner.actor);
  const other = await outsider.service.projectService.createProject(db, { name: "Private work" }, outsider.actor);
  await runtime.identity.setMembership(owner.headers, project.id, outsider.actor.id, { role: "owner" });
  await runtime.identity.setMembership(outsider.headers, project.id, owner.actor.id, { role: "owner", explicitPermissions: ["execution.review", "execution.merge"] });
  const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Executor fixture" });
  const otherAgent = await runtime.identity.createAgent(outsider.headers, { displayName: "Other fixture" });
  const permissions = ["resource.read", "resource.write", "execution.run", "execution.review", "execution.merge"];
  await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
  await runtime.identity.setMembership(outsider.headers, other.id, otherAgent.id, { role: "member", explicitPermissions: ["execution.run"] });
  async function key(actorId: string, human: any, projectId: string, actions = permissions) {
    const issued = await apiKeyService.issueScopedApiKey(db, human.context, actorId, { name: "Daemon fixture", grants: [{ scope: "project", projectId, permissions: actions }], expiresAt: null });
    const headers = new Headers({ authorization: `Bearer ${issued.rawKey}` });
    const context = await runtime.verify(headers);
    return { headers, context, issued, service: createResourceServices(context), actor: { id: context.actor.id, type: context.actor.type } };
  }
  let executor = await key(agent.id, owner, project.id);
  const foreign = await key(otherAgent.id, outsider, other.id, ["resource.read", "resource.write", "execution.run"]);
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BOOTSTRAP_SECRET: config.bootstrapSecret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  async function call(path: string, headers: Headers, input?: unknown) {
    const response = await app.request(`/api/v1/daemons/${path}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
    return { response, body: await response.json() as any };
  }
  const daemonId = randomUUID(), startedAt = new Date().toISOString();
  const registration = { id: daemonId, name: "Executor", role: "executor", capabilities: ["codex"], processStartedAt: startedAt };
  await t.test("registration binds real agents and rejects human, foreign and unbound legacy identities", async () => {
    assert.equal((await call("register", owner.headers, registration)).response.status, 403);
    const forged = new Headers(executor.headers);
    forged.set("x-actor-id", otherAgent.id); forged.set("x-actor-type", "human");
    const result = await call("register", forged, { ...registration, actorId: otherAgent.id, clientId: otherAgent.id });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.config.executionDelegationSupported, true);
    assert.equal(result.body.actorId, agent.id); assert.equal(result.body.actorType, "agent");
    assert.equal((await call("register", foreign.headers, registration)).response.status, 404);
    assert.equal((await call("register", executor.headers, { ...registration, role: "reviewer", capabilities: ["review"] })).response.status, 404);
    const legacy = randomUUID();
    await db.insert(daemons).values({ id: legacy, name: "Unbound legacy" });
    assert.equal((await call("register", executor.headers, { ...registration, id: legacy })).response.status, 404);
  });
  const privateReq = await outsider.service.requirementService.createRequirement(db, { projectId: other.id, title: "Private candidate", status: "approved" }, outsider.actor);
  await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: privateReq.id, title: "Private urgent", priority: "urgent" }, outsider.actor);
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Authorized candidate", status: "approved" }, owner.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Authorized task" }, owner.actor);
  await owner.service.taskService.createTask(db, { scope: "personal", title: "Personal work" }, owner.actor);
  let run: any;
  await t.test("queue filtering precedes diagnostics and claims across projects and personal space", async () => {
    assert.equal((await call(`${daemonId}/apply-requirement`, executor.headers, { projectId: other.id })).response.status, 404);
    const result = await call(`${daemonId}/apply-requirement`, executor.headers, { workerIndex: 0 });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.requirement.id, requirement.id);
    assert.equal(result.body.task.id, task.id);
    assert.equal(result.body.eligibility.candidateCount, 1);
    assert.ok(!JSON.stringify(result.body).includes(privateReq.id));
    run = result.body;
    assert.equal((await call(`${daemonId}/heartbeat`, foreign.headers)).response.status, 404);
    assert.equal((await call(`${daemonId}/status`, executor.headers, { status: "busy", activeTaskIds: [randomUUID()] })).response.status, 404);
  });
  await t.test("progress uses the owned instance, authorized targets and original live lease fence", async () => {
    const progress = { eventId: randomUUID(), runId: run.runId, workerIndex: 0, requirementId: requirement.id, currentTaskId: task.id, phase: "executing", workspaceState: "clean", source: "daemon", leaseGeneration: run.leaseGeneration, details: {} };
    assert.equal((await call(`${daemonId}/progress`, executor.headers, progress)).response.status, 200);
    assert.equal((await call(`${daemonId}/progress`, executor.headers, { ...progress, eventId: randomUUID(), leaseGeneration: run.leaseGeneration + 1 })).response.status, 400);
    assert.equal((await call(`${daemonId}/progress`, executor.headers, { ...progress, eventId: randomUUID(), requirementId: privateReq.id })).response.status, 404);
    assert.equal((await call(`${daemonId}/progress`, foreign.headers, progress)).response.status, 404);
  });
  await t.test("control requires management grants and does not infer authority from human or administrator type", async () => {
    assert.equal((await call(`${daemonId}/control`, admin.headers, { action: "pause", reason: "Admin without resource authority" })).response.status, 404);
    assert.equal((await call(`${daemonId}/control`, executor.headers, { action: "pause", reason: "No management ceiling" })).response.status, 403);
    assert.equal((await call(`${daemonId}/control`, owner.headers, { action: "pause", reason: "Managing human with project permission" })).response.status, 200);
    assert.equal((await call(`${daemonId}/apply-requirement`, executor.headers, {})).body.requirement, null);
    assert.equal((await call(`${daemonId}/control`, owner.headers, { action: "resume", reason: "Resume permitted work" })).response.status, 200);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "maintainer", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
    const management = await key(agent.id, owner, project.id, [...permissions, "project.manage"]);
    assert.equal((await call(`${daemonId}/control`, management.headers, { action: "drain", reason: "Agent management grant" })).response.status, 200);
    assert.equal((await call(`${daemonId}/control`, management.headers, { action: "resume", reason: "Agent management grant" })).response.status, 200);
  });
  await t.test("all roles require their explicit execution entitlement and scoped registration", async () => {
    for (const role of ["reviewer", "merger"]) {
      const id = randomUUID();
      assert.equal((await call("register", executor.headers, { ...registration, id, role, capabilities: [role === "reviewer" ? "review" : "merge"] })).response.status, 201);
      const candidate = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: `${role} work`, status: "approved" }, owner.actor);
      await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: candidate.id, title: `${role} task` }, owner.actor);
      await db.update(requirements).set({ status: role === "reviewer" ? "in_review" : "ready_to_merge" }).where(eq(requirements.id, candidate.id));
      await db.update(requirements).set({ status: role === "reviewer" ? "in_review" : "ready_to_merge" }).where(eq(requirements.id, privateReq.id));
      const acquired = await call(`${id}/${role === "reviewer" ? "apply-review" : "apply-merge"}`, executor.headers, {});
      assert.equal(acquired.response.status, 200, JSON.stringify(acquired.body));
      assert.equal(acquired.body.requirement.id, candidate.id);
      assert.ok(!JSON.stringify(acquired.body).includes(privateReq.id));
      assert.equal((await call(`${daemonId}/${role === "reviewer" ? "apply-review" : "apply-merge"}`, executor.headers, {})).response.status, 403);
    }
    const readOnly = await key(agent.id, owner, project.id, ["resource.read"]);
    assert.equal((await call("register", readOnly.headers, { ...registration, id: randomUUID() })).response.status, 403);
  });
  await t.test("rotation preserves stable actor and lease ownership while revocation and expiry reject later operations", async () => {
    const rotated = await apiKeyService.rotateScopedApiKey(db, owner.context, executor.issued.id);
    assert.equal((await call(`${daemonId}/heartbeat`, executor.headers)).response.status, 401);
    const headers = new Headers({ authorization: `Bearer ${rotated.rawKey}` });
    const context = await runtime.verify(headers);
    executor = { ...executor, headers, context, issued: rotated, service: createResourceServices(context) };
    assert.equal(context.actor.id, agent.id);
    assert.equal((await call("register", headers, registration)).response.status, 201);
    assert.equal((await call(`${daemonId}/heartbeat`, headers)).response.status, 200);
    await db.update(apiKeys).set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, rotated.id));
    assert.equal((await call(`${daemonId}/heartbeat`, headers)).response.status, 401);
  });
  await t.test("membership removal invalidates previously verified contexts and credentials immediately", async () => {
    const active = await key(agent.id, owner, project.id);
    await runtime.identity.removeMembership(owner.headers, project.id, agent.id);
    await assert.rejects(active.service.daemonService.heartbeatDaemon(db, daemonId, active.actor));
    assert.equal((await call(`${daemonId}/heartbeat`, active.headers)).response.status, 403);
  });
});
