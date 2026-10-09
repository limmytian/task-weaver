import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authRateLimits, repositories, requirementRepositories, taskRepositories, agentUsageRuns, tiAgentModelConfigs, reviewRuns, activityLog, projectMemberships, requirementClaims, schedules, scheduleRuns, tiAgentRuns, daemons, daemonWorkerProgress, daemonWorkerProgressHistory } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createAssistantService, sendAssistantMessageSchema, buildAssistantContextSchema, NotFoundError, AuthorizationError, listRepositoriesSchema, createRepositorySchema, agentUsageQuerySchema, upsertTiModelConfigSchema, createReviewRunSchema, evaluateReviewRunSchema, createScheduleSchema, listSchedulesSchema, daemonHistoryQuerySchema, daemonObservabilityQuerySchema, daemonMetricsQuerySchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("assistant authorization isolates accounts and resources across REST and tRPC", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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


  const ownerChat = createAssistantService(owner.context);
  const outsiderChat = createAssistantService(outsider.context);
  // Use only fixture credentials and a bounded model stub; never deployment secrets.
  await db.insert(tiAgentModelConfigs).values({ ownerId: owner.actor.id, ownerType: "human", provider: "fixture", model: "fixture-chat", baseUrl: "https://model.example.test/v1", apiKeyRef: "sk-fixture-only", enabled: true, isDefaultChat: true, credentialStatus: "unknown" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://model.example.test/v1/chat/completions");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer sk-fixture-only");
    calls++;
    return Response.json({ choices: [{ message: { content: "Fixture model reply" } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = sendAssistantMessageSchema.parse({ context: { projectId: project.id, requirementId: requirement.id }, message: "Summarize this project" });
  const sent = await (await caller(owner.headers)).assistant.sendMessage(input);
  assert.equal(sent.conversation.createdBy, owner.actor.id);
  assert.equal(sent.assistantMessage.content, "Fixture model reply");
  assert.equal(sent.modelError, null);
  assert.equal(calls, 1);
  await assert.rejects(outsiderChat.getConversation(db, sent.conversation.id), NotFoundError);
  await assert.rejects(outsiderChat.sendReadOnlyMessage(db, { ...input, conversationId: sent.conversation.id }), NotFoundError);
  await assert.rejects(ownerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({ conversationId: sent.conversation.id, projectId: other.id })), NotFoundError);
  const ownerContext = await ownerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({ projectId: project.id }));
  assert.ok(!JSON.stringify(ownerContext).includes("Hidden wiki target"));
  const denied = await rest(`assistant/conversations/${sent.conversation.id}`, outsider.headers);
  assert.equal(denied.status, 404);
  const history = await rest("assistant/conversations", outsider.headers);
  assert.equal(history.status, 200);
  assert.ok(!history.body.some((row: any) => row.id === sent.conversation.id));
  const restChat = await rest("assistant/chat", owner.headers, "POST", input);
  assert.equal(restChat.status, 201);
  const deniedContext = await rest("assistant/context", outsider.headers, "POST", { projectId: project.id });
  assert.equal(deniedContext.status, 404);
  const proposed = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "update_task", payload: { taskId: task.id, title: "Reviewed task" } }] }));
  const action = proposed.actions[0];
  assert.ok(action);
  await assert.rejects(outsiderChat.executeApprovedAction(db, action.id), NotFoundError);
  await assert.rejects(ownerChat.updateActionStatus(db, action.id, { status: "succeeded", executionResult: { forged: true } }), AuthorizationError);
  const executed = await ownerChat.executeApprovedAction(db, action.id);
  assert.equal(executed.status, "succeeded");
  await runtime.identity.setMembership(owner.headers, project.id, viewer.actor.id, { role: "viewer" });
  const viewerChat = createAssistantService(viewer.context);
  const viewerProposal = await viewerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "update_task", payload: { taskId: task.id, title: "Unauthorized edit" } }] }));
  await assert.rejects(viewerChat.executeApprovedAction(db, viewerProposal.actions[0].id), AuthorizationError);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live", assistantActionAllowlist: ["add_comment"], assistantDailyActionLimit: 10, assistantUncertainToReview: false });
  const taskPolicy = apiRequire("@task-weaver/core").upsertTiAgentPolicySchema.parse({ enabled: false, executionMode: "disabled", dailyRunLimit: 17 });
  await owner.service.tiAgentService.upsertPolicy(db, taskPolicy, owner.actor);
  assert.equal((await ownerChat.getPolicy(db)).assistantAutoMode, "live");
  await ownerChat.updatePolicy(db, { assistantDailyActionLimit: 3 });
  assert.equal((await owner.service.tiAgentService.getPolicy(db, {}, owner.actor)).dailyRunLimit, 17);
  assert.equal((await outsiderChat.getPolicy(db)).assistantAutoEnabled, false);
  const automatic = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Automatic fixture comment" } }] }));
  assert.equal(automatic.actions[0].status, "succeeded");
  await ownerChat.updatePolicy(db, { assistantAutoMode: "dry_run" });
  const preview = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Preview fixture comment" } }] }));
  assert.equal(preview.actions[0].status, "proposed");
  await ownerChat.updatePolicy(db, { assistantAutoMode: "live", assistantActionAllowlist: [] });
  const empty = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Blocked fixture comment" } }] }));
  assert.equal(empty.actions[0].status, "proposed");
});
