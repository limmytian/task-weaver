import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, daemons, daemonWorkerProgress, apiKeys, requirements, executionDelegations, authAuditEvents, taskClaims, documentTaskLinks } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, apiKeyService, authorizedRealtimeEvent, resourceAuthority } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("execution capabilities enforce immutable task bounds and revocable lease authority", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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
  assert.equal((await call("register", executor.headers, registration)).response.status, 201);
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Bound execution", status: "approved" }, owner.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Current task" }, owner.actor);
  const sibling = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Unrelated task" }, owner.actor);
  const otherRequirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Unrelated requirement", status: "approved" }, owner.actor);
  const outside = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: otherRequirement.id, title: "Other requirement task" }, owner.actor);
  const privateTask = await owner.service.taskService.createTask(db, { scope: "personal", title: "Human personal task" }, owner.actor);
  const document = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Task document", content: "Task context" }, owner.actor);
  const hiddenDocument = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Unrelated document", content: "Unrelated context" }, owner.actor);
  await owner.service.documentService.linkDocumentToTask(db, document.id, task.id, "references", owner.actor);
  const lane = await call(`${daemonId}/apply-requirement`, executor.headers, { projectId: project.id, workerIndex: 0 });
  assert.equal(lane.response.status, 200, JSON.stringify(lane.body));
  assert.equal(lane.body.task.id, task.id);
  const request = { requirementId: requirement.id, runId: lane.body.runId, workerIndex: 0, leaseGeneration: lane.body.leaseGeneration, taskId: task.id };
  let capability: any;
  async function issue() {
    const result = await call(`${daemonId}/delegations`, executor.headers, request);
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    capability = result.body;
    return new Headers({ authorization: `Bearer ${capability.token}` });
  }
  async function rest(path: string, headers: Headers, method = "GET", input?: unknown) {
    const requestHeaders = new Headers(headers);
    if (input !== undefined) requestHeaders.set("content-type", "application/json");
    const response = await app.request(`/api/v1/${path}`, { headers: requestHeaders, method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  }
  let headers = await issue();
  await t.test("capability material is returned once and identity, lease and bounds are server-derived", async () => {
    assert.match(capability.token, /^twd_[0-9a-f]{64}$/);
    assert.deepEqual(capability.delegation.taskIds, [task.id]);
    assert.equal(capability.delegation.executorActorId, agent.id);
    assert.equal(capability.delegation.initiator.id, agent.id);
    assert.ok(Date.parse(capability.delegation.expiresAt) <= Date.now() + 15 * 60_000);
    const [stored] = await db.select().from(executionDelegations).where(eq(executionDelegations.id, capability.delegation.id));
    assert.ok(!JSON.stringify(stored).includes(capability.token));
    assert.ok(!JSON.stringify(capability.delegation).includes("tokenHash"));
    assert.equal((await call(`${daemonId}/delegations`, foreign.headers, request)).response.status, 404);
    assert.equal((await call(`${daemonId}/delegations`, executor.headers, { ...request, taskId: outside.id })).response.status, 403);
    assert.equal((await call(`${daemonId}/delegations`, executor.headers, { ...request, grants: [{ scope: "instance", permissions: ["instance.manage"] }] })).response.status, 400);
  });
  await t.test("REST lists, details, nested requirement content and mutations stay within the current task", async () => {
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 200);
    for (const id of [sibling.id, outside.id, privateTask.id]) assert.equal((await rest(`tasks/${id}`, headers)).status, 404);
    assert.equal((await rest(`documents/${document.id}`, headers)).status, 200);
    assert.equal((await rest(`documents/${hiddenDocument.id}`, headers)).status, 404);
    const list = await rest(`projects/${project.id}/tasks`, headers);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.map((item: any) => item.id), [task.id]);
    const parent = await rest(`requirements/${requirement.id}`, headers);
    assert.equal(parent.status, 200, JSON.stringify(parent.body));
    assert.ok(!JSON.stringify(parent.body).includes(sibling.id));
    assert.equal((await rest(`projects/${project.id}/stats`, headers)).status, 403);
    assert.equal((await rest(`tasks/${task.id}`, headers, "PATCH", { assignee: owner.actor.id })).status, 403);
    assert.equal((await rest("api-keys", headers)).status, 403);
    assert.equal((await rest(`daemons/${daemonId}/heartbeat`, headers, "POST", {})).status, 403);
    const forged = new Headers(headers); forged.set("x-actor-id", owner.actor.id); forged.set("x-actor-type", "human");
    const comment = await rest(`tasks/${task.id}/comments`, forged, "POST", { content: "Delegated task evidence" });
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    assert.equal(comment.body.authorId, agent.id);
  });
  await t.test("tRPC and GraphQL reuse the same task/resource capability boundary", async () => {
    const caller = appRouter.createCaller(await createTRPCContextFactory({ db, auth: runtime })({ req: new Request(`${config.trustedOrigins[0]}/api/trpc`, { headers, method: "POST" }) }));
    assert.equal((await caller.task.get({ id: task.id })).id, task.id);
    await assert.rejects(caller.task.get({ id: sibling.id }), (error: any) => error.code === "NOT_FOUND");
    const selected = await rest("graphql", headers, "POST", { query: `{ task(id: "${task.id}") { id title } }` });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.data.task.id, task.id);
    const denied = await rest("graphql", headers, "POST", { query: `{ task(id: "${sibling.id}") { id title } }` });
    assert.equal(denied.body.data.task, null);
  });
  await t.test("events cannot reveal unrelated task or deletion/replay metadata", async () => {
    const authority = await resourceAuthority(db, await runtime.verify(headers));
    assert.ok(await authorizedRealtimeEvent(db, authority, { type: "task_updated", taskId: task.id, projectId: project.id }));
    assert.equal(await authorizedRealtimeEvent(db, authority, { type: "task_updated", taskId: sibling.id, projectId: project.id }), null);
    assert.equal(await authorizedRealtimeEvent(db, authority, { type: "document_deleted", documentId: hiddenDocument.id, projectId: project.id }), null);
  });
  await t.test("renewal rotates material without broadening bounds and only the parent supervisor can renew", async () => {
    const original = capability;
    assert.equal((await call(`${daemonId}/delegations/${original.delegation.id}/renew`, headers, {})).response.status, 403);
    const renewed = await call(`${daemonId}/delegations/${original.delegation.id}/renew`, executor.headers, {});
    assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body));
    assert.deepEqual(renewed.body.delegation.taskIds, original.delegation.taskIds);
    assert.deepEqual(renewed.body.delegation.repositoryIds, original.delegation.repositoryIds);
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    capability = renewed.body;
    headers = new Headers({ authorization: `Bearer ${capability.token}` });
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 200);
  });
  await t.test("expiry, lease supersession and parent revocation reject stale contexts and replays", async () => {
    const stale = await runtime.verify(headers);
    await db.update(executionDelegations).set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(executionDelegations.id, capability.delegation.id));
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    headers = await issue();
    await db.update(requirements).set({ leaseGeneration: lane.body.leaseGeneration + 1 }).where(eq(requirements.id, requirement.id));
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    await assert.rejects(createResourceServices(stale).taskService.getTask(db, task.id));
    await db.update(requirements).set({ leaseGeneration: lane.body.leaseGeneration }).where(eq(requirements.id, requirement.id));
    headers = await issue();
    await apiKeyService.revokeScopedApiKey(db, owner.context, executor.issued.id);
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    const audits = await db.select().from(authAuditEvents);
    assert.ok(!JSON.stringify(audits).includes(capability.token));
    assert.ok(!JSON.stringify(audits).includes(executor.issued.rawKey));
    await db.delete(taskClaims).where(eq(taskClaims.taskId, task.id));
  });
});
