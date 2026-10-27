import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
import { renderWorkerCapabilityBootstrap } from "../apps/cli/src/worker-capability-bootstrap";
import { createTaskAccessBroker } from "../apps/cli/src/task-access-broker";
import { runCommand } from "../apps/cli/src/async-command";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, daemons, daemonWorkerProgress, apiKeys, requirements, executionDelegations, authAuditEvents, mcpServers, mcpTools, taskClaims, documentTaskLinks, documents, memories, skillPackages, skillPackageVersions, skillPackageFiles } = apiRequire("@task-weaver/db");
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
  async function key(actorId: string, human: any, projectId: string, actions = permissions, shared = false) {
    const issued = await apiKeyService.issueScopedApiKey(db, human.context, actorId, { name: "Daemon fixture", grants: [{ scope: "project", projectId, permissions: actions }, ...(shared ? [{ scope: "global", permissions: ["resource.read"] }] : [])], expiresAt: null });
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
  const registration = { id: daemonId, name: "Executor", role: "executor", capabilities: ["codex", "live-plan-v1"], processStartedAt: startedAt };
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
    const response = await app.request(`${config.baseURL}/api/v1/${path}`, { headers: requestHeaders, method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  }
  let headers = await issue();
  await t.test("capability material is returned once and identity, lease and bounds are server-derived", async () => {
    assert.match(capability.token, /^twd_[0-9a-f]{64}$/);
    assert.deepEqual(capability.delegation.taskIds, [task.id]);
    assert.equal(capability.delegation.capabilityExecution, undefined);
    assert.equal(capability.delegation.sharedCapabilityReads, undefined);
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
    const secretComment = await rest(`tasks/${task.id}/comments`, headers, "POST", { content: `Secret canary ${capability.token}` });
    assert.equal(secretComment.status, 201);
    assert.equal(secretComment.body.content, "Secret canary [redacted]");

    assert.equal((await rest(`tasks/${task.id}/status`, headers, "PATCH", { status: "in_progress", force: true })).status, 403);
    assert.equal((await rest(`tasks/${task.id}/status`, headers, "PATCH", { status: "in_progress", leaseGeneration: lane.body.leaseGeneration + 1, daemonId })).status, 403);
    assert.equal((await rest(`tasks/${task.id}/status`, headers, "PATCH", { status: "in_progress" })).status, 200);

  });
  await t.test("typed capability reads do not open ordinary content or capability writes", async () => {
    const makeSkill = (projectId: string | null, title: string, extra = {}) => db.insert(documents).values({ projectId, title, content: "Inspect the current source before continuing.", docType: "skill", createdBy: owner.actor.id, ...extra }).returning().then((rows: any[]) => rows[0]);
    const skill = await makeSkill(project.id, "Capability fixture");
    const shared = await makeSkill(null, "Shared capability fixture");
    const foreign = await makeSkill(other.id, "Foreign capability fixture");
    const personal = await makeSkill(null, "Personal capability fixture", { personalOwnerId: owner.actor.id, personalOwnerType: "human" });
    assert.equal((await createResourceServices(await runtime.verify(headers)).contextService.getSkill(db, skill.id)).id, skill.id);
    assert.equal((await rest(`context/${skill.id}`, headers)).status, 200);
    assert.equal((await rest(`documents/${skill.id}`, headers)).status, 404);
    assert.equal((await rest(`context/${hiddenDocument.id}`, headers)).status, 404);
    for (const asset of [shared, foreign, personal]) assert.equal((await rest(`context/${asset.id}`, headers)).status, 404);
    const oversized = await makeSkill(project.id, "Oversized instruction fixture", { content: "x".repeat(32769) });
    const tooLarge = await rest(`context/${oversized.id}`, headers);
    assert.equal(tooLarge.status, 400);
    assert.match(tooLarge.body.error, /read limit/);
    const found = await rest(`context/search?intent=Capability&projectId=${project.id}&mode=full`, headers);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.items.map((row: any) => row.id), [skill.id]);
    assert.ok(!("content" in found.body.items[0]), "Worker discovery stays summary-only");
    assert.equal((await rest(`context/list?projectId=${project.id}`, headers)).status, 200);
    assert.equal((await rest(`context/${skill.id}`, headers, "PATCH", { content: "Do not change instructions" })).status, 403);

    const [pkg] = await db.insert(skillPackages).values({ name: "Capability fixture", projectId: project.id, primaryDocumentId: skill.id, createdBy: owner.actor.id }).returning();
    const [version] = await db.insert(skillPackageVersions).values({ packageId: pkg.id, version: "1.0.0", createdBy: owner.actor.id }).returning();
    await db.insert(skillPackageFiles).values({ packageVersionId: version.id, path: "SKILL.md", kind: "text", isReadableText: true, sizeBytes: Buffer.byteLength(skill.content), sha256: createHash("sha256").update(skill.content).digest("hex"), indexedDocumentId: skill.id });
    for (const path of [`context/packages?projectId=${project.id}`, `context/packages/${pkg.id}`, `context/packages/${pkg.id}/files`, `context/packages/${pkg.id}/read?path=SKILL.md&version=1.0.0`]) {
      const result = await rest(path, headers);
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    await db.update(skillPackageVersions).set({ status: "archived" }).where(eq(skillPackageVersions.id, version.id));
    assert.equal((await rest(`context/${skill.id}`, headers)).status, 404);
    assert.equal((await rest(`context/packages/${pkg.id}/read?path=SKILL.md&version=1.0.0`, headers)).status, 404);
    assert.equal((await rest(`context/search?intent=Capability&projectId=${project.id}`, headers)).body.items.length, 0);
    await db.update(skillPackageVersions).set({ status: "active" }).where(eq(skillPackageVersions.id, version.id));

    const [memory] = await db.insert(memories).values({ title: "Capability memory", content: "Verified source", projectId: project.id, entityType: "task", entityId: task.id, createdBy: owner.actor.id, createdByType: "human" }).returning();
    assert.equal((await rest(`memories/${memory.id}`, headers)).status, 200);
    const [unrelated] = await db.insert(memories).values({ title: "Capability memory hidden", content: "Unrelated task", projectId: project.id, entityType: "task", entityId: sibling.id, createdBy: owner.actor.id, createdByType: "human" }).returning();
    assert.equal((await rest(`memories/${unrelated.id}`, headers)).status, 404);
    assert.deepEqual((await rest(`memories/search?query=Capability&projectId=${project.id}`, headers)).body.items.map((row: any) => row.id), [memory.id]);
    await db.update(memories).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(memories.id, memory.id));
    assert.equal((await rest(`memories/${memory.id}`, headers)).status, 404);
    assert.equal((await rest(`memories?projectId=${project.id}&includeExpired=true`, headers)).body.items.length, 0);
    assert.equal((await rest("memories", headers, "POST", { projectId: project.id, title: "Unreviewed", content: "Do not save" })).status, 403);
    assert.equal((await rest(`context/packages/${pkg.id}`, headers, "PATCH", { status: "archived" })).status, 403);
    assert.equal((await call(`${daemonId}/delegations`, executor.headers, { ...request, sharedCapabilityReads: true })).response.status, 403);
    // Failed shared opt-in leaves the current delegation valid.
    assert.equal((await rest(`context/${skill.id}`, headers)).status, 200);
    const [sharedPackage] = await db.insert(skillPackages).values({ name: "Shared instruction fixture", primaryDocumentId: shared.id, createdBy: owner.actor.id }).returning();
    const [sharedVersion] = await db.insert(skillPackageVersions).values({ packageId: sharedPackage.id, version: "1.0.0", createdBy: owner.actor.id }).returning();
    await db.insert(skillPackageFiles).values({ packageVersionId: sharedVersion.id, path: "SKILL.md", kind: "text", isReadableText: true, sizeBytes: Buffer.byteLength(shared.content), sha256: createHash("sha256").update(shared.content).digest("hex"), indexedDocumentId: shared.id });
    const [sharedMemory] = await db.insert(memories).values({ title: "Shared reviewed lesson", content: "Check current source evidence", createdBy: owner.actor.id, createdByType: "human" }).returning();
    assert.equal((await rest(`context/packages/${sharedPackage.id}`, headers)).status, 404);
    assert.equal((await rest(`memories/${sharedMemory.id}`, headers)).status, 404);
    const sharedParent = await key(agent.id, owner, project.id, permissions, true);
    const opted = await call(`${daemonId}/delegations`, sharedParent.headers, { ...request, sharedCapabilityReads: true });
    assert.equal(opted.response.status, 201, opted.body.error);
    const sharedHeaders = new Headers({ authorization: `Bearer ${opted.body.token}` });
    assert.equal((await rest(`context/${shared.id}`, sharedHeaders)).status, 200);
    assert.equal((await rest(`context/packages/${sharedPackage.id}/read?path=SKILL.md&version=1.0.0`, sharedHeaders)).status, 200);
    assert.equal((await rest(`memories/${sharedMemory.id}`, sharedHeaders)).status, 200);
    assert.equal((await rest(`documents/${shared.id}`, sharedHeaders)).status, 404);
    assert.equal((await rest(`context/${personal.id}`, sharedHeaders)).status, 404);
    assert.equal((await rest(`context/${foreign.id}`, sharedHeaders)).status, 404);
    assert.equal((await rest(`documents/${hiddenDocument.id}`, sharedHeaders)).status, 404);
    assert.equal((await rest(`context/${shared.id}`, sharedHeaders, "PATCH", { content: "No shared writes" })).status, 403);
    const renewed = await call(`${daemonId}/delegations/${opted.body.delegation.id}/renew`, sharedParent.headers, {});
    assert.equal(renewed.response.status, 200, renewed.body.error);
    assert.equal((await rest(`context/${shared.id}`, new Headers({ authorization: `Bearer ${renewed.body.token}` }))).status, 200);
    await apiKeyService.revokeScopedApiKey(db, owner.context, sharedParent.issued.id);
    assert.equal((await rest(`context/${shared.id}`, new Headers({ authorization: `Bearer ${renewed.body.token}` }))).status, 401);
    // Return subsequent lifecycle tests to the original project-only supervisor.
    headers = await issue();
    const bootstrap = await rest("context/bootstrap", headers);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.capabilityBootstrap.capabilities.skills.state, "available");
    assert.equal(bootstrap.body.capabilityBootstrap.capabilities.hostedExecution.state, "unavailable");
    const rendered = renderWorkerCapabilityBootstrap(bootstrap.body.capabilityBootstrap, project.id);
    assert.match(rendered, /Worker Capability Bootstrap/);
    assert.ok(Buffer.byteLength(rendered) <= 4096);
  });
  await t.test("capability execution requires parent opt-in, exact schemas and reviewed source-linked saves", async () => {
    assert.equal((await call(`${daemonId}/delegations`, executor.headers, { ...request, capabilityExecution: true })).response.status, 403);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "execution.review", "execution.merge", "mcp.invoke"] });
    const invoker = await key(agent.id, owner, project.id, [...permissions, "mcp.invoke"]);
    const issued = await call(`${daemonId}/delegations`, invoker.headers, { ...request, capabilityExecution: true });
    assert.equal(issued.response.status, 201, issued.body.error);
    assert.equal(issued.body.delegation.capabilityExecution, true);
    const executionHeaders = new Headers({ authorization: `Bearer ${issued.body.token}` });
    const context = await runtime.verify(executionHeaders);
    const services = createResourceServices(context);
    const [server] = await db.insert(mcpServers).values({ projectId: project.id, name: "Scoped external fixture", transport: "streamable-http", config: { url: "https://example.test/mcp" }, registeredBy: owner.actor.id, active: true, status: "connected" }).returning();
    const [tool] = await db.insert(mcpTools).values({ serverId: server.id, name: "scoped_fixture", description: "Capability fixture", inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false }, readOnly: true }).returning();
    const inspected = await rest(`mcp/tools/${tool.id}`, executionHeaders);
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.match(inspected.body.schemaHash, /^[a-f0-9]{64}$/);
    let invocations = 0;
    const pool = { getOrConnect: async () => ({ listTools: async () => ({ tools: [] }), callTool: async () => { invocations++; return { content: [{ type: "text", text: "Verified fixture result" }] }; } }), disconnect: async () => {}, isConnected: () => true };
    for (const schema of [undefined, "0".repeat(64)]) await assert.rejects(services.mcpRegistryService.callTool(db, tool.id, { text: "test" }, context.actor, pool, undefined, schema));
    assert.equal(invocations, 0);
    await services.mcpRegistryService.callTool(db, tool.id, { text: "test" }, context.actor, pool, undefined, inspected.body.schemaHash);
    assert.equal(invocations, 1);
    await db.update(mcpTools).set({ inputSchema: { type: "object", properties: { changed: { type: "boolean" } } } }).where(eq(mcpTools.id, tool.id));
    await assert.rejects(services.mcpRegistryService.callTool(db, tool.id, {}, context.actor, pool, undefined, inspected.body.schemaHash));
    assert.equal(invocations, 1, "Schema drift must not dispatch or replay");
    const source = await owner.service.taskService.getTask(db, task.id);
    const save = { title: "Verified capability handoff", content: "Inspected fixture schema before using the verified result.", projectId: project.id, entityType: "task", entityId: task.id, provenance: { origin: "reviewed_source", sourceUpdatedAt: source.updatedAt.toISOString() }, idempotencyKey: randomUUID(), confirmed: true };
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, confirmed: undefined })).status, 403);
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, provenance: { origin: "explicit" } })).status, 403);
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, entityId: sibling.id })).status, 404);
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, projectId: other.id })).status, 403);
    const saved = await rest("memories", executionHeaders, "POST", save);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await rest("memories", executionHeaders, "POST", save)).body.id, saved.body.id);
    const currentMemory = await rest(`memories/${saved.body.id}`, executionHeaders);
    assert.equal(currentMemory.body.sourceFreshness, "current");
    assert.equal(currentMemory.body.expired, false);
    await db.update(memories).set({ provenance: { origin: "reviewed_source", sourceUpdatedAt: new Date(0).toISOString() } }).where(eq(memories.id, saved.body.id));
    assert.equal((await rest(`memories/${saved.body.id}`, executionHeaders)).body.sourceFreshness, "changed");
    const remoteMemory = await rest("mcp-server/tools/tw_memories_get", executionHeaders, "POST", { id: saved.body.id });
    assert.equal(remoteMemory.body.structuredContent.data.sourceFreshness, "changed");
    await db.update(memories).set({ provenance: save.provenance }).where(eq(memories.id, saved.body.id));
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, idempotencyKey: randomUUID(), provenance: { origin: "reviewed_source", sourceUpdatedAt: new Date(0).toISOString() } })).status, 409);
    assert.equal((await rest(`memories/${saved.body.id}`, executionHeaders, "PATCH", { content: "No unrelated edits" })).status, 403);
    const preview = await rest("mcp-server/tools/tw_memories_preview", executionHeaders, "POST", { sourceType: "task", sourceId: task.id, scope: "project", projectId: project.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.isError, undefined, JSON.stringify(preview.body));
    let invalidations = 0;
    const broker = await createTaskAccessBroker({ apiUrl: config.baseURL, capability: issued.body,
      renew: async () => { throw new Error("Unexpected fixture renewal"); }, revoke: async () => {},
      onInvalidation: () => { invalidations++; },
      fetch: async (url, input) => app.request(String(url), input),
    });
    t.after(() => broker.close());
    const brokerHeaders = { authorization: `Bearer ${broker.apiKey}`, "content-type": "application/json" };
    const child = await runCommand(process.execPath, ["-e", `fetch(process.env.TW_API_URL + '/api/v1/mcp/tools/${tool.id}', { headers: { authorization: 'Bearer ' + process.env.TW_API_KEY } }).then(async response => { if (!response.ok) process.exit(1); console.log((await response.json()).schemaHash); })`], {
      env: { TW_API_URL: broker.apiUrl, TW_API_KEY: broker.apiKey }, timeoutMs: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout.trim(), /^[a-f0-9]{64}$/);
    const brokerSave = await fetch(`${broker.apiUrl}/api/v1/memories`, { method: "POST", headers: brokerHeaders, body: JSON.stringify(save) });
    assert.equal(brokerSave.status, 201);
    assert.equal((await brokerSave.json() as any).id, saved.body.id);
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/documents/${hiddenDocument.id}`, { headers: brokerHeaders })).status, 404);
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/mcp/policy`, { method: "POST", headers: brokerHeaders, body: "{}" })).status, 403);
    const reported = await fetch(`${broker.apiUrl}/api/v1/tasks/${task.id}/comments`, { method: "POST", headers: brokerHeaders, body: JSON.stringify({ content: "Agent report: the fixture was useful." }) });
    assert.equal(reported.status, 201);
    const reportId = (await reported.json() as any).id;
    const capabilityEvents = await db.select().from(authAuditEvents).where(eq(authAuditEvents.entityId, issued.body.delegation.id));
    assert.ok(capabilityEvents.some((event: any) => event.metadata.runId === request.runId && event.metadata.assetId === saved.body.id && event.metadata.assetVersion === "1" && event.metadata.evidenceSource === "api"));
    assert.ok(capabilityEvents.some((event: any) => event.metadata.assetId === tool.id && event.metadata.assetSha256 === inspected.body.schemaHash && event.metadata.assetHashKind === "tool_schema"));
    assert.ok(capabilityEvents.some((event: any) => event.metadata.reportId === reportId && event.metadata.evidenceSource === "agent_report" && !event.metadata.assetId));
    assert.ok(!JSON.stringify(capabilityEvents).includes(save.content));
    const unrelatedFacade = await rest("mcp-server/tools/tw_documents_get", executionHeaders, "POST", { id: hiddenDocument.id });
    assert.equal(unrelatedFacade.body.isError, true, "Delegation facade cannot broaden ordinary document access");
    await apiKeyService.revokeScopedApiKey(db, owner.context, invoker.issued.id);
    await assert.rejects(services.mcpRegistryService.callTool(db, tool.id, {}, context.actor, pool, undefined, inspected.body.schemaHash));
    assert.equal(invocations, 1, "Revoked parent must not dispatch another tool call");
    await fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: brokerHeaders }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(invalidations, 1);
    await assert.rejects(fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: brokerHeaders }));
    await broker.close();
    assert.equal((await rest("memories", executionHeaders, "POST", { ...save, idempotencyKey: randomUUID() })).status, 401);
    headers = await issue();
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
  await t.test("removing and restoring a document link cannot restore the old task capability", async () => {
    const oldHeaders = headers;
    const link = await db.query.documentTaskLinks.findFirst({ where: eq(documentTaskLinks.documentId, document.id) });
    await owner.service.documentService.unlinkDocumentFromTask(db, link.id);
    assert.equal((await rest(`tasks/${task.id}`, oldHeaders)).status, 401);
    await owner.service.documentService.linkDocumentToTask(db, document.id, task.id, "references", owner.actor);
    assert.equal((await rest(`tasks/${task.id}`, oldHeaders)).status, 401);
    headers = await issue();
    assert.equal((await rest(`documents/${document.id}`, headers)).status, 200);
  });
  await t.test("membership changes permanently revoke capabilities and restored membership requires a fresh exchange", async () => {
    const oldHeaders = headers;
    await runtime.identity.removeMembership(owner.headers, project.id, agent.id);
    assert.equal((await rest(`tasks/${task.id}`, oldHeaders)).status, 401);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
    assert.equal((await rest(`tasks/${task.id}`, oldHeaders)).status, 401);
    headers = await issue();
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 200);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "viewer" });
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
    headers = await issue();
  });
  await t.test("ordinary Key grant edits invalidate execution capabilities permanently, including no-op safety", async () => {
    headers = await issue();
    const original = executor.issued;
    const grants = original.grants;
    await runtime.identity.updateKeyGrants(owner.headers, agent.id, original.id, { grants, expectedVersion: original.grantVersion });
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 200);
    const narrowed = grants.map((grant: any) => ({ ...grant, permissions: grant.permissions.filter((permission: string) => permission !== "execution.merge") }));
    await runtime.identity.updateKeyGrants(owner.headers, agent.id, original.id, { grants: narrowed, expectedVersion: original.grantVersion });
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    assert.equal((await call(`${daemonId}/delegations/${capability.delegation.id}/renew`, executor.headers, {})).response.status, 401);
    await runtime.identity.updateKeyGrants(owner.headers, agent.id, original.id, { grants, expectedVersion: original.grantVersion + 1 });
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    headers = await issue();
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
  await t.test("completed tasks revoke old grants permanently and disabling the Agent ends its execution", async () => {
    executor = await key(agent.id, owner, project.id);
    headers = await issue();
    assert.equal((await rest(`tasks/${task.id}/status`, headers, "PATCH", { status: "done", reason: "Bound task completed" })).status, 200);
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 401);
    await runtime.identity.disableAgent(owner.headers, agent.id);
    assert.equal((await call(`${daemonId}/delegations`, executor.headers, request)).response.status, 401);
  });
});
