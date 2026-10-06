import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authRateLimits, repositories, requirementRepositories, taskRepositories, agentUsageRuns, tiAgentModelConfigs, reviewRuns, activityLog, projectMemberships, requirementClaims, schedules, scheduleRuns, tiAgentRuns, daemons, daemonWorkerProgress, daemonWorkerProgressHistory } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, listRepositoriesSchema, createRepositorySchema, agentUsageQuerySchema, upsertTiModelConfigSchema, createReviewRunSchema, evaluateReviewRunSchema, createScheduleSchema, listSchedulesSchema, daemonHistoryQuerySchema, daemonObservabilityQuerySchema, daemonMetricsQuerySchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("metadata authorization rejects cross-scope reads and forged attribution", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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
  const owner = await human(), outsider = await human(), viewer = await human(), member = await human();
  const project = await owner.service.projectService.createProject(db, { name: "Owned project" }, owner.actor);
  const other = await outsider.service.projectService.createProject(db, { name: "Other project" }, outsider.actor);
  await runtime.identity.setMembership(owner.headers, project.id, viewer.actor.id, { role: "viewer" });
  await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member" });
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Work", status: "approved" }, owner.actor);
  const otherRequirement = await outsider.service.requirementService.createRequirement(db, { projectId: other.id, title: "Private work", status: "approved" }, outsider.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Task" }, owner.actor);
  const doc = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Project document", content: "Version one" }, owner.actor);
  const personal = await owner.service.documentService.createDocument(db, { personalOwnerId: owner.actor.id, personalOwnerType: "human", title: "Private note", content: "Private content" }, owner.actor);
  const hiddenDoc = await outsider.service.documentService.createDocument(db, { personalOwnerId: outsider.actor.id, personalOwnerType: "human", title: "Hidden wiki target", content: "Hidden content" }, outsider.actor);
  const api = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  async function rest(path: string, headers: Headers, method = "GET", body?: unknown) {
    const response = await api.request(`/api/v1/${path}`, { headers: new Headers([...headers, ["content-type", "application/json"]]), method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function caller(headers: Headers) {
    return appRouter.createCaller(await createTRPCContextFactory({ db, auth: runtime })({ req: new Request(`${config.trustedOrigins[0]}/api/trpc`, { headers, method: "POST" }) }));
  }


  const usageQuery = agentUsageQuerySchema.parse({ projectId: project.id });
  async function usage(projectId: string, requirementId: string, taskId: string | null, tokens: number) {
    const [row] = await db.insert(agentUsageRuns).values({ processId: randomUUID(), projectId, requirementId, taskId, source: "daemon_unknown", agent: "fixture", phase: "execution", outcome: "succeeded", startedAt: new Date(), revision: 1, reportedBy: owner.actor.id, summary: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheSemantics: "unknown", provider: "fixture", model: "fixture", completeness: "complete" } }).returning();
    return row;
  }
  const visible = await usage(project.id, requirement.id, task.id, 10);
  const poisoned = await usage(project.id, otherRequirement.id, task.id, 9999);
  await usage(other.id, otherRequirement.id, null, 9999);
  await t.test("usage filters stored scope relations before limits and totals", async () => {
    const result = await owner.service.agentUsageService.listUsage(db, { ...usageQuery, limit: 1 });
    assert.equal(result.total, 1); assert.equal(result.items[0].processId, visible.processId);
    const total = await owner.service.agentUsageService.summarizeUsage(db, usageQuery);
    assert.equal(total.runs, 1); assert.equal(total.inputTokens, "10");
    await assert.rejects(owner.service.agentUsageService.getUsage(db, project.id, poisoned.processId), NotFoundError);
    for (const identity of [admin, outsider, viewer, member]) await assert.rejects(identity.service.agentUsageService.listUsage(db, usageQuery));
  });
  await t.test("scoped keys need audit permission, and live membership revocation applies", async () => {
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Usage read only", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    await assert.rejects(createResourceServices(context).agentUsageService.listUsage(db, usageQuery));
    const auditKey = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Usage audit", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "audit.read"] }], expiresAt: null });
    const auditContext = await runtime.verify(new Headers({ authorization: `Bearer ${auditKey.rawKey}` }));
    const auditService = createResourceServices(auditContext);
    assert.equal((await auditService.agentUsageService.listUsage(db, usageQuery)).total, 1);
    await runtime.identity.revokeKey(owner.headers, owner.actor.id, auditKey.id);
    await assert.rejects(auditService.agentUsageService.listUsage(db, usageQuery));
    await assert.rejects(owner.service.agentUsageService.reportDaemonUsage(db, {}, owner.actor), AuthorizationError);
  });
  await t.test("REST and tRPC enforce the same usage boundaries", async () => {
    assert.equal((await rest(`agent-usage/runs?projectId=${project.id}`, owner.headers)).status, 200);
    assert.equal((await rest(`agent-usage/summary?projectId=${project.id}`, admin.headers)).status, 404);
    const web = await caller(owner.headers); assert.equal((await web.agentUsage.summary(usageQuery)).runs, 1);
  });
  await t.test("Ti overrides never grant administrators personal content", async () => {
    await db.insert(tiAgentModelConfigs).values({ ownerId: owner.actor.id, ownerType: "human", provider: "fixture", model: "fixture", apiKeyRef: "private-reference", baseUrl: "https://private.example.test" });
    const configs = await owner.service.tiAgentService.listModelConfigs(db, { includeDisabled: false }, owner.actor);
    assert.equal(configs.length, 1); assert.ok(!JSON.stringify(configs).includes("private-reference"));
    assert.ok(!JSON.stringify(configs).includes("private.example.test"));
    for (const identity of [admin, outsider]) await assert.rejects(identity.service.tiAgentService.listModelConfigs(db, { ownerId: owner.actor.id, ownerType: "human", includeDisabled: false }, identity.actor));
    const config = upsertTiModelConfigSchema.parse({ provider: "fixture", model: "new" });
    await assert.rejects(owner.service.tiAgentService.upsertModelConfig(db, config, owner.actor), AuthorizationError);
    const created = await admin.service.tiAgentService.upsertModelConfig(db, config, admin.actor);
    assert.equal(created.ownerId, admin.actor.id);
    await assert.rejects(owner.service.tiAgentService.acquireRun(db, {}, owner.actor), AuthorizationError);
  });
  await t.test("activity visibility filters before pagination and strips arbitrary metadata", async () => {
    await db.insert(activityLog).values({ entityType: "task", entityId: task.id, actorId: owner.actor.id, actorType: "human", action: "fixture", metadata: { secret: "private-provider-secret" } });
    const rows = await owner.service.activityLogService.listActivityLog(db, { projectId: project.id, limit: 100 });
    assert.ok(rows.some((row: any) => row.entityId === task.id));
    assert.ok(!JSON.stringify(rows).includes("private-provider-secret"));
    assert.equal((await admin.service.activityLogService.listActivityLog(db, { limit: 100 })).filter((row: any) => row.entityId === task.id).length, 0);
    await assert.rejects(viewer.service.activityLogService.listActivityLog(db, { projectId: project.id }));
  });
  await t.test("review permissions preserve role and stored delivery identities", async () => {
    await assert.rejects(admin.service.reviewService.getProjectReviewPolicy(db, project.id));
    await assert.rejects(viewer.service.reviewService.upsertProjectReviewPolicy(db, project.id, {}, viewer.actor));
    const [repo] = await db.insert(repositories).values({ displayName: "Review fixture", host: "example.test", namespace: "fixture", name: randomUUID(), canonicalKey: randomUUID(), visibility: "instance", createdBy: admin.actor.id }).returning();
    const [link] = await db.insert(requirementRepositories).values({ requirementId: requirement.id, repositoryId: repo.id, baseBranch: "0.3.3", headCommit: "abcdef0123456789", executorActorId: outsider.actor.id, executorActorType: "human" }).returning();
    const input = createReviewRunSchema.parse({ requirementRepositoryId: link.id, headCommit: "abcdef0123456789", baseCommit: "0123456789abcdef" });
    await assert.rejects(owner.service.reviewService.startReviewRun(db, requirement.id, { ...input, executorActorId: owner.actor.id }, owner.actor), AuthorizationError);
    await db.update(projectMemberships).set({ explicitPermissions: ["execution.review"] }).where(eq(projectMemberships.actorId, owner.actor.id));
    const run = await owner.service.reviewService.startReviewRun(db, requirement.id, input, owner.actor);
    assert.equal(run.executorActorId, outsider.actor.id);
    await assert.rejects(owner.service.reviewService.evaluateReviewRun(db, run.id, evaluateReviewRunSchema.parse({ mergerActorId: outsider.actor.id, mergerActorType: "human" }), owner.actor), AuthorizationError);
    const [lease] = await db.insert(requirementClaims).values({ requirementId: requirement.id, claimedBy: outsider.actor.id, claimedByType: "human", expiresAt: new Date(Date.now() + 60_000) }).returning();
    await assert.rejects(owner.service.reviewService.evaluateReviewRun(db, run.id, {}, owner.actor));
    assert.equal((await owner.service.reviewService.getReviewRun(db, run.id)).status, "running");
    await db.delete(requirementClaims).where(eq(requirementClaims.id, lease.id));
    await db.update(requirementRepositories).set({ headCommit: "changed-head" }).where(eq(requirementRepositories.id, link.id));
    await assert.rejects(owner.service.reviewService.evaluateReviewRun(db, run.id, {}, owner.actor));
    await db.update(requirementRepositories).set({ headCommit: run.headCommit }).where(eq(requirementRepositories.id, link.id));
    await assert.rejects(outsider.service.reviewService.getReviewRun(db, run.id));
    assert.equal((await owner.service.reviewService.listRequirementReviewRuns(db, requirement.id, { limit: 10, offset: 0 })).length, 1);
  });
  await t.test("schedule ownership and relation changes require both scopes", async () => {
    const input = createScheduleSchema.parse({ targetScope: "personal", kind: "one_off", title: "Private reminder", startsAt: new Date(), taskTemplate: { title: "Reminder" } });
    const row = await owner.service.scheduleService.createSchedule(db, input, owner.actor);
    assert.equal(row.personalOwnerId, owner.actor.id); assert.equal(row.personalOwnerType, "human");
    await assert.rejects(admin.service.scheduleService.getSchedule(db, row.id), NotFoundError);
    await assert.rejects(owner.service.scheduleService.updateSchedule(db, row.id, { personalOwnerId: outsider.actor.id }, owner.actor));
    const listed = await owner.service.scheduleService.listSchedules(db, listSchedulesSchema.parse({}));
    assert.ok(listed.some((item: any) => item.id === row.id));
    const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Schedule Agent" });
    const key = await runtime.identity.issueKey(owner.headers, agent.id, { name: "Personal schedule", grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const service = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    const agentRow = await service.scheduleService.createSchedule(db, input, { id: agent.id, type: "agent" });
    assert.equal(agentRow.personalOwnerId, owner.actor.id); assert.equal(agentRow.createdBy, agent.id);
    await assert.rejects(service.scheduleService.acquireDueSchedules(db, {}, { id: agent.id, type: "agent" }), AuthorizationError);
    await assert.rejects(owner.service.scheduleService.createSchedule(db, { ...input, assignedExecutor: outsider.actor.id, assignedExecutorType: "human" }, owner.actor));
    const projectSchedule = await owner.service.scheduleService.createSchedule(db, createScheduleSchema.parse({ ...input, targetScope: "project", projectId: project.id, requirementId: requirement.id }), owner.actor);
    await assert.rejects(owner.service.scheduleService.updateSchedule(db, projectSchedule.id, { requirementId: otherRequirement.id }, owner.actor));
    const moved = await owner.service.scheduleService.updateSchedule(db, projectSchedule.id, { targetScope: "personal", projectId: null, requirementId: null }, owner.actor);
    assert.equal(moved.personalOwnerId, owner.actor.id);
    const [run] = await db.insert(scheduleRuns).values({ scheduleId: row.id, plannedFor: new Date(), generatedTaskId: task.id }).returning();
    await assert.rejects(owner.service.scheduleService.getSchedule(db, row.id), NotFoundError);
    assert.ok(!(await owner.service.scheduleService.listSchedules(db, listSchedulesSchema.parse({}))).some((item: any) => item.id === row.id));
    await db.delete(scheduleRuns).where(eq(scheduleRuns.id, run.id));
  });
  await t.test("Ti run reads quarantine orphaned and poisoned schedule relationships", async () => {
    const [visibleRun] = await db.insert(tiAgentRuns).values({ taskId: task.id, createdBy: owner.actor.id, outputSummary: "Visible result", eventLog: [{ secret: "private-event" }] }).returning();
    const [hiddenRun] = await db.insert(tiAgentRuns).values({ createdBy: owner.actor.id, outputSummary: "Orphaned result" }).returning();
    const rows = await owner.service.tiAgentService.listRuns(db, { limit: 100 });
    assert.ok(rows.some((row: any) => row.id === visibleRun.id)); assert.ok(!rows.some((row: any) => row.id === hiddenRun.id));
    assert.ok(!JSON.stringify(rows).includes("private-event"));
    await assert.rejects(admin.service.tiAgentService.getRun(db, visibleRun.id), NotFoundError);
  });
  await t.test("observability filters shared daemons, queue and history before pagination", async () => {
    const [daemon] = await db.insert(daemons).values({ name: "Fixture daemon", host: "fixture-host", role: "executor", status: "idle", activeWorkerStates: [{ index: 99, requirementId: otherRequirement.id, branch: "secret-foreign-branch" }] }).returning();
    const common = { daemonId: daemon.id, role: "executor", phase: "executing", leaseGeneration: 1, version: 1 };
    await db.insert(daemonWorkerProgress).values([
      { ...common, workerIndex: 0, runId: randomUUID(), requirementId: requirement.id, currentTaskId: task.id, message: "Visible progress" },
      { ...common, workerIndex: 1, runId: randomUUID(), requirementId: otherRequirement.id, message: "foreign-progress-secret" },
    ]);
    await db.insert(daemonWorkerProgressHistory).values([
      { ...common, source: "fixture", workerIndex: 0, runId: randomUUID(), requirementId: requirement.id, currentTaskId: task.id, message: "Visible progress" },
      { ...common, source: "fixture", workerIndex: 1, runId: randomUUID(), requirementId: otherRequirement.id, message: "foreign-progress-secret", occurredAt: new Date(Date.now() + 1000) },
    ]);
    const history = await owner.service.daemonProgressService.listCorrelatedHistory(db, daemonHistoryQuerySchema.parse({ limit: 1 }));
    assert.equal(history.items.length, 1); assert.ok(!JSON.stringify(history).includes("foreign-progress-secret"));
    const overview = await owner.service.daemonObservabilityService.getDaemonObservabilityOverview(db, daemonObservabilityQuerySchema.parse({}));
    assert.ok(!JSON.stringify(overview).includes("secret-foreign-branch")); assert.ok(!JSON.stringify(overview).includes(otherRequirement.id));
    const adminView = await admin.service.daemonObservabilityService.getDaemonObservabilityOverview(db, daemonObservabilityQuerySchema.parse({}));
    assert.equal(adminView.daemons.length, 0); assert.equal(adminView.queue.total, 0);
    const metrics = await owner.service.daemonMetricsService.getDaemonMetricsReport(db, daemonMetricsQuerySchema.parse({}));
    assert.ok(!JSON.stringify(metrics).includes(otherRequirement.id));
    const hidden = await admin.service.daemonProgressService.listCorrelatedHistory(db, daemonHistoryQuerySchema.parse({ daemonId: daemon.id }));
    assert.equal(hidden.items.length, 0);
  });

});
