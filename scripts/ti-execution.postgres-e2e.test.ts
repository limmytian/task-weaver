import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createApiApplication } from "../apps/api/src/application";
import { createRequire } from "node:module";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authRateLimits, tiAgentRuns, tiAgentModelConfigs, tiAgentPolicies, executionDelegations, requirementClaims, assistantConversations, assistantActions } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createTiExecutionService, apiKeyService, assistantService, createScheduleSchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const { createGatewayTwAuthority } = apiRequire("../../packages/partners-gateway/src/tw-authority.ts");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("Ti runs preserve initiator ceilings and fence separate executor capabilities", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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
  await runtime.identity.setMembership(outsider.headers, project.id, owner.actor.id, { role: "owner", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
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
  const executor = await key(agent.id, owner, project.id);
  const foreign = await key(otherAgent.id, outsider, other.id, ["resource.read", "resource.write", "execution.run"]);
  await db.insert(tiAgentModelConfigs).values({ ownerId: owner.actor.id, ownerType: "human", provider: "fixture", model: "safe", enabled: true, isDefaultAgent: true, credentialStatus: "valid" });
  await db.insert(tiAgentPolicies).values({ ownerId: owner.actor.id, ownerType: "human", enabled: true, executionMode: "dry_run" });
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Ti work", status: "approved" }, owner.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Assigned Ti task", assignee: agent.id, assigneeType: "agent" }, owner.actor);
  const sibling = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Unrelated task" }, owner.actor);
  const supervisor = createTiExecutionService(executor.context);
  const create = () => owner.service.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: "agent" }, owner.actor);
  let run: any;
  let acquired: any;
  let capability: any;
  const worker = { assignedAgentId: agent.id, workerId: "fixture-worker", durationMinutes: 15 };
  await t.test("queue records the real initiator without accepting owner overrides or implicit personal execution", async () => {
    await assert.rejects(() => foreign.service.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: "agent" }, foreign.actor));
    await assert.rejects(() => owner.service.tiAgentService.resolveModel(db, { ownerId: outsider.actor.id, target: "agent" }, owner.actor));
    run = await create();
    assert.equal(run.createdBy, owner.actor.id);
    assert.equal(run.authorization, undefined);
    const stored = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) });
    assert.equal(stored.authorization.initiatorActorId, owner.actor.id);
    assert.equal(stored.authorization.executorActorId, agent.id);
  });
  await t.test("acquisition binds the executor key and original requirement lease, never worker labels alone", async () => {
    await assert.rejects(() => foreign.service.tiAgentService.acquireRun(db, worker, foreign.actor));
    await assert.rejects(() => executor.service.tiAgentService.acquireRun(db, { ...worker, durationMinutes: 16 }, executor.actor));
    acquired = await executor.service.tiAgentService.acquireRun(db, worker, executor.actor);
    assert.equal(acquired.id, run.id);
    assert.ok(acquired.leaseGeneration > 0);
    assert.equal(acquired.authorization, undefined);
    await assert.rejects(() => supervisor.invoke(db, "completeRun", [run.id, { status: "succeeded", workerId: worker.workerId, leaseGeneration: acquired.leaseGeneration + 1 }]));
    await assert.rejects(() => createTiExecutionService(foreign.context).invoke(db, "heartbeatRunLease", [run.id, { workerId: worker.workerId, leaseGeneration: acquired.leaseGeneration, durationMinutes: 15 }]));
  });
  const fence = () => ({ workerId: worker.workerId, leaseGeneration: acquired.leaseGeneration });
  await t.test("automation tokens expose only current task authority and preserve human initiation", async () => {
    capability = await supervisor.issueDelegation(db, run.id, fence());
    assert.match(capability.token, /^twd_[0-9a-f]{64}$/);
    assert.equal(capability.delegation.purpose, "automation");
    assert.equal(capability.delegation.initiator.id, owner.actor.id);
    assert.equal(capability.delegation.executorActorId, agent.id);
    assert.deepEqual(capability.delegation.taskIds, [task.id]);
    const child = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${capability.token}` })));
    assert.equal((await child.taskService.getTask(db, task.id)).id, task.id);
    await assert.rejects(() => child.taskService.getTask(db, sibling.id));
    await assert.rejects(() => child.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id }, executor.actor));
    const renewed = await supervisor.renewDelegation(db, run.id, capability.delegation.id, fence());
    await assert.rejects(() => runtime.verify(new Headers({ authorization: `Bearer ${capability.token}` })));
    assert.deepEqual(renewed.delegation.taskIds, capability.delegation.taskIds);
    capability = renewed;
  });
  await t.test("Ti usage shares the original executor key, attempt and lease fence", async () => {
    const input = { ...fence(), processId: randomUUID(), attempt: acquired.retryCount, startedAt: new Date().toISOString(), revision: 0, outcome: "running", endedAt: null, summary: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheSemantics: "unknown", provider: "fixture", model: "safe", completeness: "unknown" } };
    await assert.rejects(() => foreign.service.agentUsageService.reportTiUsage(db, run.id, input, foreign.actor));
    await assert.rejects(() => executor.service.agentUsageService.reportTiUsage(db, run.id, { ...input, leaseGeneration: input.leaseGeneration + 1 }, executor.actor));
    const report = await executor.service.agentUsageService.reportTiUsage(db, run.id, input, executor.actor);
    assert.equal(report.reportedBy, agent.id); assert.equal(report.leaseGeneration, acquired.leaseGeneration); assert.equal(report.workerIndex, worker.workerId);
  });
  await t.test("completion revokes children and a completed execution cannot renew", async () => {
    await supervisor.invoke(db, "completeRun", [run.id, { ...fence(), status: "succeeded" }]);
    await assert.rejects(() => runtime.verify(new Headers({ authorization: `Bearer ${capability.token}` })));
    await assert.rejects(() => supervisor.renewDelegation(db, run.id, capability.delegation.id, fence()));
    assert.equal(await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirement.id) }), undefined);
  });
  await t.test("expired Ti leases and retries exchange fresh fences without restoring old child authority", async () => {
    const queued = await owner.service.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: "agent", maxRetries: 1 }, owner.actor);
    const first = await executor.service.tiAgentService.acquireRun(db, worker, executor.actor);
    assert.equal(first.id, queued.id);
    const firstFence = { workerId: worker.workerId, leaseGeneration: first.leaseGeneration };
    const old = await supervisor.issueDelegation(db, first.id, firstFence);
    await db.update(tiAgentRuns).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(tiAgentRuns.id, first.id));
    await db.update(requirementClaims).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(requirementClaims.requirementId, requirement.id));
    await assert.rejects(() => runtime.verify(new Headers({ authorization: `Bearer ${old.token}` })));
    await assert.rejects(() => supervisor.invoke(db, "heartbeatRunLease", [first.id, { ...firstFence, durationMinutes: 15 }]));
    const second = await executor.service.tiAgentService.acquireRun(db, worker, executor.actor);
    assert.equal(second.id, first.id); assert.ok(second.leaseGeneration > first.leaseGeneration);
    const secondFence = { workerId: worker.workerId, leaseGeneration: second.leaseGeneration };
    await assert.rejects(() => supervisor.invoke(db, "completeRun", [first.id, { ...firstFence, status: "succeeded" }]));
    const child = await supervisor.issueDelegation(db, first.id, secondFence);
    const retried = await supervisor.invoke(db, "scheduleRunRetry", [first.id, { ...secondFence, errorMessage: `Retry ${child.token}`, delayMs: 0 }]);
    assert.equal(retried.status, "queued"); assert.equal(retried.retryCount, second.retryCount + 1);
    assert.ok(!JSON.stringify(retried).includes(child.token));
    await assert.rejects(() => runtime.verify(new Headers({ authorization: `Bearer ${child.token}` })));
    const third = await executor.service.tiAgentService.acquireRun(db, worker, executor.actor);
    assert.equal(third.id, first.id); assert.ok(third.leaseGeneration > second.leaseGeneration);
    await supervisor.invoke(db, "completeRun", [third.id, { workerId: worker.workerId, leaseGeneration: third.leaseGeneration, status: "succeeded" }]);
  });
  await t.test("assistant approval uses the real owner and current payload targets", async () => {
    const [conversation] = await db.insert(assistantConversations).values({ projectId: project.id, createdBy: owner.actor.id, createdByType: "human" }).returning();
    const [action] = await db.insert(assistantActions).values({ conversationId: conversation.id, actionType: "add_comment", payload: { taskId: task.id, content: "Approved work" } }).returning();
    await assert.rejects(() => assistantService.executeApprovedAction(db, action.id, owner.actor));
    await assert.rejects(() => assistantService.executeApprovedAction(db, action.id, outsider.actor, outsider.context));
    await assert.rejects(() => assistantService.executeApprovedAction(db, action.id, owner.actor, owner.context));
    await db.update(tiAgentPolicies).set({ assistantAutoEnabled: true, assistantAutoMode: "live" }).where(eq(tiAgentPolicies.ownerId, owner.actor.id));
    const completed = await assistantService.executeApprovedAction(db, action.id, owner.actor, owner.context);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.approvalActorId, owner.actor.id);
    const outsideRequirement = await outsider.service.requirementService.createRequirement(db, { projectId: other.id, title: "Foreign target", status: "approved" }, outsider.actor);
    const outsideTask = await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: outsideRequirement.id, title: "Foreign task" }, outsider.actor);
    const [poisoned] = await db.insert(assistantActions).values({ conversationId: conversation.id, actionType: "add_comment", payload: { taskId: outsideTask.id, content: "Forbidden" } }).returning();
    await assert.rejects(() => assistantService.executeApprovedAction(db, poisoned.id, owner.actor, owner.context));
    assert.equal((await db.query.assistantActions.findFirst({ where: eq(assistantActions.id, poisoned.id) })).status, "proposed");
  });
  await t.test("manual schedules propagate verified initiation to the assigned project run", async () => {
    const input = createScheduleSchema.parse({ projectId: project.id, requirementId: requirement.id, targetScope: "project", kind: "one_off", title: "Bound schedule", startsAt: new Date(), taskTemplate: { title: "Scheduled task" }, autoRun: true, assignedExecutor: agent.id, assignedExecutorType: "agent" });
    const schedule = await owner.service.scheduleService.createSchedule(db, input, owner.actor);
    await assert.rejects(() => admin.service.scheduleService.runScheduleNow(db, schedule.id, admin.actor));
    const occurrence = await owner.service.scheduleService.runScheduleNow(db, schedule.id, owner.actor);
    const queued = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.scheduleRunId, occurrence.id) });
    assert.equal(queued.authorization.initiatorActorId, owner.actor.id);
    assert.equal(queued.authorization.executorActorId, agent.id);
    assert.equal(queued.taskId, occurrence.generatedTaskId);
    await db.update(tiAgentRuns).set({ status: "cancelled" }).where(eq(tiAgentRuns.id, queued.id));
    await assert.rejects(() => owner.service.scheduleService.createSchedule(db, createScheduleSchema.parse({ ...input, targetScope: "personal", projectId: null, requirementId: null }), owner.actor));
  });
  await t.test("Partners service credentials cannot authorize TW and tool calls stay task bounded", async () => {
    run = await create();
    const workerConfig = { actorId: agent.id, assignedAgentId: agent.id, workerId: worker.workerId };
    const gateway = { enabled: true, baseUrl: "http://fixture.invalid", serviceToken: "gateway-canary", tenantId: "foreign-tenant", projectId: "foreign-partners-project", defaultTimeoutSeconds: 900 };
    await assert.rejects(() => createGatewayTwAuthority(db, gateway, workerConfig, () => undefined).acquireRun(db, worker));
    await assert.rejects(() => createGatewayTwAuthority(db, gateway, workerConfig, () => gateway.serviceToken).acquireRun(db, worker));
    const adapter = createGatewayTwAuthority(db, gateway, workerConfig, () => executor.issued.rawKey);
    acquired = await adapter.acquireRun(db, worker);
    assert.equal(acquired.id, run.id);
    const delegation = await adapter.authorizeDispatch(run.id);
    assert.equal(delegation.initiator.id, owner.actor.id);
    assert.equal(delegation.executorActorId, agent.id);
    assert.equal((await adapter.invokeTool(run.id, (services: any) => services.taskService.getTask(db, task.id))).id, task.id);
    await assert.rejects(() => adapter.invokeTool(run.id, (services: any) => services.taskService.getTask(db, sibling.id)));
    await adapter.updateRunProgress(db, run.id, { workerId: worker.workerId, eventLog: [{ chunk: executor.issued.rawKey + " gateway-canary" }], actualProvider: "partners-gateway", actualModel: "interpreter" });
    await adapter.validateRun(run.id);
    assert.ok(!JSON.stringify(await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) })).includes("gateway-canary"));
    await adapter.completeRun(db, run.id, { status: "succeeded" });
    await assert.rejects(() => adapter.invokeTool(run.id, (services: any) => services.taskService.getTask(db, task.id)));
  });
  await t.test("REST uses verified actors, scoped keys and explicit worker fences", async () => {
    const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BOOTSTRAP_SECRET: config.bootstrapSecret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
    async function post(path: string, headers: Headers, input: unknown) {
      const response = await app.request(`/api/v1/ti/${path}`, { method: "POST", headers: new Headers([...headers, ["content-type", "application/json"], ["x-actor-id", outsider.actor.id]]), body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() as any };
    }
    const queued = await post("runs", owner.headers, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: "agent" });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));
    assert.equal(queued.body.createdBy, owner.actor.id);
    const lane = await post("runs/acquire", executor.headers, worker);
    assert.equal(lane.status, 200, JSON.stringify(lane.body));
    const input = { workerId: worker.workerId, leaseGeneration: lane.body.leaseGeneration };
    const minted = await post(`runs/${lane.body.id}/delegations`, executor.headers, input);
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const childHeaders = new Headers({ authorization: `Bearer ${minted.body.token}` });
    assert.equal((await post("runs/acquire", childHeaders, worker)).status, 403);
    assert.equal((await post(`runs/${lane.body.id}/complete`, foreign.headers, { ...input, status: "succeeded" })).status, 403);
    assert.equal((await post(`runs/${lane.body.id}/complete`, executor.headers, { ...input, status: "succeeded" })).status, 200);
  });
  await t.test("membership removal cancels queued and live work permanently", async () => {
    run = await create();
    await runtime.identity.removeMembership(owner.headers, project.id, agent.id);
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run"] });
    assert.equal((await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) })).status, "cancelled");
    assert.equal(await executor.service.tiAgentService.acquireRun(db, worker, executor.actor), null);
  });
  await t.test("persisted runs, audit DTOs and token verifiers do not contain raw capability material", async () => {
    assert.ok(!JSON.stringify(await db.select().from(tiAgentRuns)).includes(capability.token));
    assert.ok(!JSON.stringify(await db.select().from(executionDelegations)).includes(capability.token));
  });
});
