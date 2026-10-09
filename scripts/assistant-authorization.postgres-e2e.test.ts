import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authRateLimits, repositories, requirementRepositories, taskRepositories, agentUsageRuns, tiAgentModelConfigs, reviewRuns, activityLog, projectMemberships, requirementClaims, schedules, scheduleRuns, tiAgentRuns, daemons, daemonWorkerProgress, daemonWorkerProgressHistory } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createAssistantService, createChatModelService, sendAssistantMessageSchema, buildAssistantContextSchema, NotFoundError, AuthorizationError, listRepositoriesSchema, createRepositorySchema, agentUsageQuerySchema, upsertTiModelConfigSchema, createReviewRunSchema, evaluateReviewRunSchema, createScheduleSchema, listSchedulesSchema, daemonHistoryQuerySchema, daemonObservabilityQuerySchema, daemonMetricsQuerySchema } = apiRequire("@task-weaver/core");
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
  const oldMaster = process.env.TW_CHAT_CREDENTIAL_MASTER_KEY;
  process.env.TW_CHAT_CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  t.after(() => { if (oldMaster === undefined) delete process.env.TW_CHAT_CREDENTIAL_MASTER_KEY; else process.env.TW_CHAT_CREDENTIAL_MASTER_KEY = oldMaster; });
  const modelSettings = { provider: "fixture", model: "fixture-chat", baseUrl: "https://model.example.test/v1", apiKey: "fixture-personal-key", enabled: true, isDefaultChat: true, credentialStatus: "unknown" };
  const ownerModels = createChatModelService(owner.context);
  const savedModel = await ownerModels.save(db, modelSettings);
  await createChatModelService(viewer.context).save(db, modelSettings);
  let calls = 0;
  let lastModelPrompt = "";
  let lastModelPayload: any;
  const modelReplies: any[] = [];
  let expectedKey = "fixture-personal-key";
  let responseStatus = 200;
  let dnsAddress = "8.8.8.8";
  t.mock.method(dns, "lookup", async () => [{ address: dnsAddress, family: 4 }]);
  t.mock.method(https, "request", (url: URL, options: any, callback: any) => {
    assert.equal(String(url), "https://model.example.test/v1/chat/completions");
    assert.equal(options.headers.authorization, `Bearer ${expectedKey}`);
    calls++;
    const request = new EventEmitter() as any;
    request.end = (body: string) => {
      lastModelPayload = JSON.parse(body);
      lastModelPrompt = lastModelPayload.messages.map((message: any) => message.content).join("\n");
      const response = new EventEmitter() as any;
      response.statusCode = responseStatus;
      response.resume = () => {};
      callback(response);
      queueMicrotask(() => { response.emit("data", Buffer.from(JSON.stringify({ choices: [{ message: modelReplies.shift() ?? { content: "Fixture model reply" } }] }))); response.emit("end"); });
    };
    return request;
  });
  const input = sendAssistantMessageSchema.parse({ context: { projectId: project.id, requirementId: requirement.id }, message: "Summarize this project" });
  const sent = await (await caller(owner.headers)).assistant.sendMessage(input);
  assert.equal(sent.conversation.createdBy, owner.actor.id);
  assert.equal(sent.assistantMessage.content, "Fixture model reply");
  assert.equal(sent.modelError, null);
  assert.equal(calls, 1);
  await assert.rejects(outsiderChat.getConversation(db, sent.conversation.id), NotFoundError);
  await assert.rejects(outsiderChat.sendReadOnlyMessage(db, { ...input, conversationId: sent.conversation.id }), NotFoundError);
  await assert.rejects(ownerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({ conversationId: sent.conversation.id, projectId: other.id })), NotFoundError);
  const globalContext = await ownerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({}));
  const workspace = globalContext.workspace as any;
  assert.deepEqual(workspace.projectCounts, { active: 1, archived: 0, total: 1 });
  assert.deepEqual(workspace.projects.map((row: any) => row.id), [project.id]);
  assert.equal(workspace.projectsTruncated, false);
  assert.equal((globalContext.current as any).project, null);
  assert.ok(!JSON.stringify(workspace).includes(other.id));
  const outsiderContext = await outsiderChat.buildAssistantContext(db, buildAssistantContextSchema.parse({}));
  assert.deepEqual((outsiderContext.workspace as any).projects.map((row: any) => row.id), [other.id]);
  const globalRest = await rest("assistant/context", owner.headers, "POST", {});
  assert.equal(globalRest.status, 200);
  assert.deepEqual(globalRest.body.workspace.projectCounts, workspace.projectCounts);
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
  const globalChat = await rest("assistant/chat", owner.headers, "POST", { message: "How many projects can I access?", context: {} });
  assert.equal(globalChat.status, 201);
  assert.ok(lastModelPrompt.includes('"active": 1'));
  assert.ok(lastModelPrompt.includes(project.name));
  assert.ok(!lastModelPrompt.includes(other.name));
  assert.ok(lastModelPrompt.includes("no project is selected"));
  const toolCall = (name: string, args: unknown) => ({ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });
  modelReplies.push(
    { content: null, tool_calls: [toolCall("list_projects", { query: "Owned" })] },
    { content: null, tool_calls: [toolCall("get_project", { projectId: project.id }), toolCall("list_tasks", { projectId: project.id })] },
    { content: "Live project status checked" },
  );
  const queried = await rest("assistant/chat", owner.headers, "POST", { message: "Check Owned project status", context: {} });
  assert.equal(queried.status, 201);
  assert.equal(queried.body.assistantMessage.content, "Live project status checked");
  const results = lastModelPayload.messages.filter((row: any) => row.role === "tool").map((row: any) => JSON.parse(row.content));
  assert.equal(results.length, 3);
  assert.equal(results[0].total, 1);
  assert.equal(results[1].project.id, project.id);
  assert.equal(results[1].statistics.totalTasks, 1);
  assert.ok(JSON.stringify(results[2]).includes(task.id));
  assert.ok(!JSON.stringify(results).includes(other.id));
  assert.ok(lastModelPayload.tools.every((row: any) => !row.function.name.startsWith("create_") && !row.function.name.startsWith("update_")));
  modelReplies.push({ content: null, tool_calls: [toolCall("get_project", { projectId: other.id }), toolCall("get_document", { documentId: hiddenDoc.id }), toolCall("update_task", { taskId: task.id, title: "Malicious mutation" })] }, { content: "Those resources are unavailable" });
  const deniedTools = await rest("assistant/chat", owner.headers, "POST", { message: "Try inaccessible queries", context: {} });
  assert.equal(deniedTools.status, 201);
  const deniedResults = lastModelPayload.messages.filter((row: any) => row.role === "tool").map((row: any) => JSON.parse(row.content));
  assert.ok(deniedResults.every((row: any) => row.error));
  assert.ok(!JSON.stringify(deniedResults).includes(hiddenDoc.content));
  assert.equal((await owner.service.taskService.getTask(db, task.id)).title, "Task");
  const beforeLoop = calls;
  for (let round = 0; round < 10; round++) modelReplies.push({ content: null, tool_calls: [toolCall("list_projects", {})] });
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ message: "Unbounded query fixture", context: {} })), /query limit reached/);
  assert.equal(calls - beforeLoop, 10);
  assert.equal(lastModelPayload.tool_choice, "none");
  const proposed = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "update_task", payload: { taskId: task.id, title: "Reviewed task" } }] }));
  const action = proposed.actions[0];
  assert.ok(action);
  await assert.rejects(outsiderChat.executeApprovedAction(db, action.id), NotFoundError);
  await assert.rejects(ownerChat.updateActionStatus(db, action.id, { status: "succeeded", executionResult: { forged: true } }), AuthorizationError);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const executed = await ownerChat.executeApprovedAction(db, action.id);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  assert.equal(executed.status, "succeeded");
  assert.equal((await owner.service.taskService.getTask(db, task.id)).title, "Reviewed task");
  // Exercise the same structured task proposal and confirmation routes used by Chat.
  const taskProposal = await (await caller(owner.headers)).assistant.sendMessage(sendAssistantMessageSchema.parse({ ...input, message: "Create a follow-up", proposedActions: [{ actionType: "create_task", payload: { projectId: project.id, requirementId: requirement.id, title: "Confirmed Chat task" } }] }));
  assert.equal(taskProposal.actions[0].status, "proposed");
  const foreignExecution = await rest(`assistant/actions/${taskProposal.actions[0].id}/execute`, outsider.headers, "POST");
  assert.equal(foreignExecution.status, 404);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const confirmedTask = await (await caller(owner.headers)).assistant.executeAction({ id: taskProposal.actions[0].id });
  assert.equal(confirmedTask.status, "succeeded");
  const createdTask = await owner.service.taskService.getTask(db, confirmedTask.executionResult.entityId);
  assert.equal(createdTask.title, "Confirmed Chat task");
  assert.equal(createdTask.requirementId, requirement.id);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  const documentProposal = await rest("assistant/chat", owner.headers, "POST", { ...input, proposedActions: [{ actionType: "draft_document", payload: { projectId: project.id, title: "Confirmed Chat draft", content: "Reviewed content" } }] });
  assert.equal(documentProposal.status, 201);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const confirmedDocument = await rest(`assistant/actions/${documentProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(confirmedDocument.status, 200);
  assert.equal(confirmedDocument.body.status, "succeeded");
  const createdDocument = await owner.service.documentService.getDocument(db, confirmedDocument.body.executionResult.entityId);
  assert.equal(createdDocument.content, "Reviewed content");
  assert.equal(createdDocument.needsReview, true);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  const noteProposal = await rest("assistant/chat", owner.headers, "POST", { ...input, proposedActions: [{ actionType: "add_note", payload: { taskId: task.id, content: "Confirmed Chat note", pinned: true } }] });
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const confirmedNote = await rest(`assistant/actions/${noteProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(confirmedNote.status, 200);
  assert.equal(confirmedNote.body.executionResult.result.content, "Confirmed Chat note");
  assert.equal(confirmedNote.body.executionResult.result.pinned, true);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  const scheduleProposal = await rest("assistant/chat", owner.headers, "POST", { ...input, proposedActions: [{ actionType: "create_schedule", payload: { projectId: project.id, requirementId: requirement.id, kind: "one_off", title: "Confirmed Chat schedule", startsAt: new Date(Date.now() + 86_400_000).toISOString(), taskTemplate: { title: "Scheduled follow-up" } } }] });
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const confirmedSchedule = await rest(`assistant/actions/${scheduleProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(confirmedSchedule.status, 200);
  const scheduleId = confirmedSchedule.body.executionResult.entityId;
  assert.equal((await owner.service.scheduleService.getSchedule(db, scheduleId)).title, "Confirmed Chat schedule");
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  const pauseProposal = await rest("assistant/chat", owner.headers, "POST", { ...input, proposedActions: [{ actionType: "pause_schedule", payload: { scheduleId } }] });
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const paused = await rest(`assistant/actions/${pauseProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(paused.status, 200);
  assert.equal((await owner.service.scheduleService.getSchedule(db, scheduleId)).status, "paused");
  // Queueing a Ti run must retain the independent execution entitlement check.
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  const queueProposal = await rest("assistant/chat", owner.headers, "POST", { ...input, proposedActions: [{ actionType: "queue_ti_run", payload: { taskId: task.id, assignedAgentId: viewer.actor.id } }] });
  assert.equal(queueProposal.status, 201);
  assert.equal(queueProposal.body.actions[0].status, "proposed");
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const deniedQueue = await rest(`assistant/actions/${queueProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(deniedQueue.status, 403);
  await runtime.identity.setMembership(owner.headers, project.id, viewer.actor.id, { role: "viewer" });
  const viewerChat = createAssistantService(viewer.context);
  const viewerProposal = await viewerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "update_task", payload: { taskId: task.id, title: "Unauthorized edit" } }] }));
  await viewerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  await assert.rejects(viewerChat.executeApprovedAction(db, viewerProposal.actions[0].id), AuthorizationError);
  const deniedWrite = await rest(`assistant/actions/${viewerProposal.actions[0].id}/execute`, viewer.headers, "POST");
  assert.equal(deniedWrite.status, 403);
  assert.equal((await owner.service.taskService.getTask(db, task.id)).title, "Reviewed task");
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live", assistantActionAllowlist: ["add_comment"], assistantDailyActionLimit: 10, assistantUncertainToReview: false });
  const taskPolicy = apiRequire("@task-weaver/core").upsertTiAgentPolicySchema.parse({ enabled: false, executionMode: "disabled", dailyRunLimit: 17 });
  await owner.service.tiAgentService.upsertPolicy(db, taskPolicy, owner.actor);
  assert.equal((await ownerChat.getPolicy(db)).assistantAutoMode, "live");
  await ownerChat.updatePolicy(db, { assistantDailyActionLimit: 10 });
  assert.equal((await owner.service.tiAgentService.getPolicy(db, {}, owner.actor)).dailyRunLimit, 17);
  assert.equal((await outsiderChat.getPolicy(db)).assistantAutoEnabled, false);
  const automatic = await (await caller(owner.headers)).assistant.sendMessage(sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Automatic fixture comment" } }] }));
  assert.equal(automatic.actions[0].status, "succeeded");
  assert.equal(automatic.actions[0].executionResult.result.content, "Automatic fixture comment");
  await ownerChat.updatePolicy(db, { assistantAutoMode: "dry_run" });
  const preview = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Preview fixture comment" } }] }));
  assert.equal(preview.actions[0].status, "proposed");
  await ownerChat.updatePolicy(db, { assistantAutoMode: "live", assistantActionAllowlist: [] });
  const empty = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Blocked fixture comment" } }] }));
  assert.equal(empty.actions[0].status, "succeeded");
  assert.equal(empty.actions[0].executionResult.result.content, "Blocked fixture comment");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("platform_operation_schema", { operation: "create_requirement" })] },
    { content: null, tool_calls: [toolCall("platform_operation", { operation: "create_requirement", input: { projectId: project.id, title: "Chat-created requirement" } })] },
    { content: "Requirement created through a real authorized operation" },
  );
  const naturalRequirement = await rest("assistant/chat", owner.headers, "POST", { message: "Create a requirement for the project", context: { projectId: project.id } });
  assert.equal(naturalRequirement.status, 201);
  assert.equal(naturalRequirement.body.actions[0].status, "succeeded");
  const createdRequirementId = naturalRequirement.body.actions[0].executionResult.entityId;
  assert.equal((await owner.service.requirementService.getRequirement(db, createdRequirementId)).title, "Chat-created requirement");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("platform_operation", { operation: "create_task", input: { projectId: project.id, requirementId: createdRequirementId, title: "Chat-created task" } })] },
    { content: "Task created through a real authorized operation" },
  );
  const naturalTask = await rest("assistant/chat", owner.headers, "POST", { message: "Create its first task", context: { projectId: project.id, requirementId: createdRequirementId } });
  assert.equal(naturalTask.status, 201);
  assert.equal(naturalTask.body.actions[0].status, "succeeded");
  const createdTaskId = naturalTask.body.actions[0].executionResult.entityId;
  assert.equal((await owner.service.taskService.getTask(db, createdTaskId)).requirementId, createdRequirementId);
  modelReplies.push(
    { content: null, tool_calls: [toolCall("platform_operation", { operation: "add_task_dependency", input: { taskId: createdTaskId, dependsOnTaskId: task.id, type: "blocks" } })] },
    { content: "Dependency created" },
  );
  const orchestrated = await rest("assistant/chat", owner.headers, "POST", { message: "Make it depend on the existing task", context: { projectId: project.id } });
  assert.equal(orchestrated.status, 201);
  assert.equal(orchestrated.body.actions[0].status, "succeeded");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("platform_operation", { operation: "create_execution_slice", input: { requirementId: createdRequirementId, title: "Chat execution plan", taskIds: [createdTaskId], allowParallel: false } })] },
    { content: "Execution slice created" },
  );
  const sliceOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Put the task in an ordered execution slice", context: { projectId: project.id } });
  assert.equal(sliceOperation.status, 201);
  assert.equal(sliceOperation.body.actions[0].status, "succeeded");
  assert.equal((await owner.service.requirementService.listExecutionSlices(db, createdRequirementId))[0].title, "Chat execution plan");
  modelReplies.push({ content: null, tool_calls: [toolCall("platform_operation", { operation: "create_requirement", input: { projectId: other.id, title: "Unauthorized requirement" } })] });
  const foreignOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Attempt a foreign project write", context: {} });
  assert.equal(foreignOperation.status, 403);
  assert.equal((await outsider.service.requirementService.listRequirements(db, { projectId: other.id })).length, 1);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  modelReplies.push({ content: null, tool_calls: [toolCall("platform_operation", { operation: "create_requirement", input: { projectId: project.id, title: "Forbidden requirement" } })] }, { content: "Operations are disabled" });
  const deniedOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Create while disabled", context: { projectId: project.id } });
  assert.equal(deniedOperation.status, 201);
  assert.equal(deniedOperation.body.actions.length, 0);
  assert.ok(lastModelPayload.tools.every((tool: any) => !tool.function.name.startsWith("platform_operation")));
  const configs = await ownerModels.list(db);
  assert.equal(configs[0].hasApiKey, true);
  assert.ok(!JSON.stringify(configs).includes("fixture-personal-key"));
  const raw = await db.query.tiAgentModelConfigs.findFirst({ where: eq(tiAgentModelConfigs.id, savedModel.id) });
  assert.ok(raw.encryptedApiKey.startsWith("v1."));
  assert.ok(!raw.encryptedApiKey.includes("fixture-personal-key"));
  await ownerModels.save(db, { provider: "fixture", model: "fixture-chat", label: "Edited model" });
  assert.equal((await ownerModels.list(db))[0].hasApiKey, true);
  await assert.rejects(createChatModelService(outsider.context).deleteKey(db, savedModel.id), NotFoundError);
  await ownerModels.deleteKey(db, savedModel.id);
  const beforeMissing = calls;
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, input));
  assert.equal(calls, beforeMissing);
  await ownerModels.save(db, { ...modelSettings, apiKey: "fixture-personal-key" });
  await ownerModels.test(db, savedModel.id);
  await ownerModels.save(db, { provider: "fixture", model: "fixture-chat", apiKey: "fixture-replaced-key" });
  expectedKey = "fixture-replaced-key";
  const replaced = await ownerChat.sendReadOnlyMessage(db, input);
  assert.equal(replaced.assistantMessage.content, "Fixture model reply");
  const beforePrivate = calls;
  dnsAddress = "127.0.0.1";
  await assert.rejects(ownerModels.test(db, savedModel.id), /Private model endpoints/);
  assert.equal(calls, beforePrivate);
  dnsAddress = "8.8.8.8";
  responseStatus = 302;
  await assert.rejects(ownerModels.test(db, savedModel.id), error => error instanceof Error && !error.message.includes(expectedKey) && /Model request failed/.test(error.message));
  responseStatus = 200;
  const legacyId = randomUUID();
  await db.insert(tiAgentModelConfigs).values({ id: legacyId, ownerId: owner.actor.id, ownerType: "human", provider: "legacy", model: "legacy-chat", baseUrl: "https://model.example.test/v1", apiKeyRef: "FIXTURE_CHAT_UPGRADE_KEY", credentialStatus: "unknown", enabled: true });
  process.env.FIXTURE_CHAT_UPGRADE_KEY = "fixture-never-imported";
  t.after(() => { delete process.env.FIXTURE_CHAT_UPGRADE_KEY; });
  const beforeLegacy = calls;
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, { ...input, requestedProvider: "legacy", requestedModel: "legacy-chat" }), /key re-entry/);
  assert.equal(calls, beforeLegacy);
  const legacy = (await ownerModels.list(db)).find((row: any) => row.id === legacyId);
  assert.equal(legacy.baseUrl, "https://model.example.test/v1");
  assert.equal(legacy.requiresKeyEntry, true);
  const safeTi = await rest("ti/configs?includeDisabled=true", owner.headers);
  assert.equal(safeTi.status, 200);
  assert.ok(!JSON.stringify(safeTi.body).includes("encryptedApiKey"));
  assert.ok(!JSON.stringify(safeTi.body).includes(expectedKey));
  expectedKey = "fixture-personal-key";
  const viewerGlobal = await viewerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ message: "List my projects", context: {} }));
  await runtime.identity.removeMembership(owner.headers, project.id, viewer.actor.id);
  await assert.rejects(viewerChat.getConversation(db, viewerGlobal.conversation.id), NotFoundError);
  const emptyWorkspace = await viewerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({}));
  assert.deepEqual((emptyWorkspace.workspace as any).projectCounts, { active: 0, archived: 0, total: 0 });
  assert.deepEqual((emptyWorkspace.workspace as any).projects, []);
  for (let index = 0; index < 51; index++) {
    const inventoryProject = await owner.service.projectService.createProject(db, { name: `Inventory ${index}` }, owner.actor);
    if (index === 0) await owner.service.projectService.updateProject(db, inventoryProject.id, { status: "archived" }, owner.actor);
  }
  const visibleInventory = await owner.service.projectService.listProjects(db, {});
  const boundedWorkspace = await ownerChat.buildAssistantContext(db, buildAssistantContextSchema.parse({}));
  assert.deepEqual((boundedWorkspace.workspace as any).projectCounts, {
    active: visibleInventory.filter((row: any) => row.status === "active").length,
    archived: visibleInventory.filter((row: any) => row.status === "archived").length,
    total: visibleInventory.length,
  });
  assert.equal(visibleInventory.length, 51);
  assert.equal((boundedWorkspace.workspace as any).projects.length, 50);
  assert.equal((boundedWorkspace.workspace as any).projectsTruncated, true);

});
