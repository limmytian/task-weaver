import { Readable } from "node:stream";
import { createAssistantStreamHandler } from "../apps/web/lib/assistant-stream-handler";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
const { createDb, runMigrations, authInstanceState, authRateLimits, repositories, requirementRepositories, taskRepositories, agentUsageRuns, assistantMessages, tiAgentModelConfigs, reviewRuns, activityLog, apiKeys, projectMemberships, requirementClaims, schedules, scheduleRuns, tiAgentRuns, daemons, daemonWorkerProgress, daemonWorkerProgressHistory } = apiRequire("@task-weaver/db");
const { apiKeyService, registerMcpServerSchema, createAuthenticationRuntime, createResourceServices, createAssistantService, createChatModelService, sendAssistantMessageSchema, buildAssistantContextSchema, NotFoundError, AuthorizationError, listRepositoriesSchema, createRepositorySchema, agentUsageQuerySchema, upsertTiModelConfigSchema, createReviewRunSchema, evaluateReviewRunSchema, createScheduleSchema, listSchedulesSchema, daemonHistoryQuerySchema, daemonObservabilityQuerySchema, daemonMetricsQuerySchema } = apiRequire("@task-weaver/core");
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
  let pauseStream: (() => Promise<void>) | undefined;
  let truncateStream = false;
  t.mock.method(dns, "lookup", async () => [{ address: dnsAddress, family: 4 }]);
  t.mock.method(https, "request", (url: URL, options: any, callback: any) => {
    assert.equal(String(url), "https://model.example.test/v1/chat/completions");
    assert.equal(options.headers.authorization, expectedKey ? `Bearer ${expectedKey}` : undefined);
    calls++;
    const request = new EventEmitter() as any;
    request.destroy = () => {};
    request.end = (body: string) => {
      lastModelPayload = JSON.parse(body);
      lastModelPrompt = lastModelPayload.messages.map((message: any) => message.content).join("\n");
      if (lastModelPayload.stream) {
        const reply = modelReplies.shift() ?? { content: "Fixture streamed reply" };
        const encode = (value: any) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
        const wait = pauseStream; pauseStream = undefined;
        const truncated = truncateStream; truncateStream = false;
        const response = Readable.from((async function* () {
          if (reply.content) {
            yield encode({ choices: [{ delta: { content: reply.content.slice(0, 64) } }] });
            if (wait) await wait();
            yield encode({ choices: [{ delta: { content: reply.content.slice(64) } }] });
          }
          for (const [index, call] of (reply.tool_calls ?? []).entries()) {
            yield encode({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments.slice(0, 4) } }] } }] });
            yield encode({ choices: [{ delta: { tool_calls: [{ index, type: call.type, function: { arguments: call.function.arguments.slice(4) } }] } }] });
          }
          if (!truncated) {
            yield encode({ choices: [{ delta: {}, finish_reason: reply.tool_calls?.length ? "tool_calls" : "stop" }] });
            yield Buffer.from("data: [DONE]\n\n");
          }
        })()) as any;
        response.statusCode = responseStatus; response.headers = { "content-type": "text/event-stream" }; callback(response); return;
      }
      const response = new EventEmitter() as any;
      response.statusCode = responseStatus;
      response.resume = () => {};
      callback(response);
      queueMicrotask(() => { response.emit("data", Buffer.from(JSON.stringify({ choices: [{ message: modelReplies.shift() ?? { content: "Fixture model reply" } }] }))); response.emit("end"); });
    };
    return request;
  });
  const input = sendAssistantMessageSchema.parse({ context: { projectId: project.id, requirementId: requirement.id }, message: "Summarize this project" });
  const messageRequestId = randomUUID();
  const sent = await (await caller(owner.headers)).assistant.sendMessage({ ...input, requestId: messageRequestId });
  assert.equal(sent.conversation.createdBy, owner.actor.id);
  assert.equal(sent.assistantMessage.content, "Fixture model reply");
  assert.equal(sent.modelError, null);
  assert.equal(calls, 1);
  const repeated = await (await caller(owner.headers)).assistant.sendMessage({ ...input, requestId: messageRequestId });
  assert.equal(repeated.userMessage.id, sent.userMessage.id);
  assert.equal(repeated.assistantMessage.id, sent.assistantMessage.id);
  assert.equal(calls, 1);
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, { ...input, requestId: messageRequestId, message: "Different request" }), /different input/);
  const streamHandler = createAssistantStreamHandler(() => ({ db, auth: runtime }));
  const { SseDecoder } = apiRequire("@task-weaver/contracts");
  const streamRequest = (headers: Headers, value: any) => streamHandler(new Request(`${config.trustedOrigins[0]}/api/assistant/stream`, { method: "POST", headers, body: JSON.stringify(value) }));
  const streamInput = { ...input, requestId: randomUUID(), message: "Stream a verified fixture reply" };
  let releaseStream!: () => void;
  pauseStream = () => new Promise<void>(resolve => { releaseStream = resolve; });
  modelReplies.push({ content: "Visible first fragment " + "x".repeat(100) });
  const streaming = await streamRequest(owner.headers, streamInput);
  assert.equal(streaming.status, 200); assert.match(streaming.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(streaming.headers.get("x-accel-buffering"), "no");
  const streamReader = streaming.body!.getReader(); const framing = new SseDecoder(); const decoded = new TextDecoder();
  const events: any[] = [];
  while (!events.some(event => event.type === "text")) {
    const chunk = await streamReader.read(); assert.equal(chunk.done, false);
    events.push(...framing.push(decoded.decode(chunk.value, { stream: true })).map((frame: string) => JSON.parse(frame)));
  }
  assert.equal((await ownerChat.getMessageResult(db, { requestId: streamInput.requestId })).status, "running");
  releaseStream();
  while (true) { const chunk = await streamReader.read(); if (chunk.done) break; events.push(...framing.push(decoded.decode(chunk.value, { stream: true })).map((frame: string) => JSON.parse(frame))); }
  const streamComplete = events.find(event => event.type === "completed"); assert(streamComplete);
  assert.equal(events.filter(event => event.type === "text").map(event => event.delta).join(""), streamComplete.result.assistantMessage.content);
  assert.equal((await outsiderChat.getMessageResult(db, { requestId: streamInput.requestId })).status, "not_found");
  const streamCalls = calls;
  const duplicateStream = await streamRequest(owner.headers, streamInput);
  assert.equal(duplicateStream.status, 200); assert.match(await duplicateStream.text(), /"type":"completed"/);
  assert.equal(calls, streamCalls);
  assert.equal((await streamRequest(outsider.headers, { ...streamInput, requestId: randomUUID() })).status, 404);
  const noCsrf = new Headers(owner.headers); noCsrf.delete("x-csrf-token");
  assert.equal((await streamRequest(noCsrf, { ...streamInput, requestId: randomUUID() })).status, 403);
  const beforeStreamPolicy = await ownerChat.getPolicy(db);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const truncatedInput = { ...input, requestId: randomUUID(), message: "Never execute incomplete tool arguments" };
  truncateStream = true; modelReplies.push({ content: null, tool_calls: [{ id: "unfinished", type: "function", function: { name: "create_requirement", arguments: JSON.stringify({ projectId: project.id, title: "Never created" }) } }] });
  const truncatedResponse = await streamRequest(owner.headers, truncatedInput);
  assert.match(await truncatedResponse.text(), /"type":"failed"/);
  assert.equal((await ownerChat.getMessageResult(db, { requestId: truncatedInput.requestId })).status, "failed");
  assert((await owner.service.requirementService.listRequirements(db, { projectId: project.id })).every((row: any) => row.title !== "Never created"));
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: beforeStreamPolicy.assistantAutoEnabled, assistantAutoMode: beforeStreamPolicy.assistantAutoMode });
  const revokedStreamInput = { ...input, requestId: randomUUID(), message: "Revalidate access before each text batch" };
  pauseStream = () => new Promise<void>(resolve => { releaseStream = resolve; });
  modelReplies.push({ content: "Authorized preview ".padEnd(64, ".") + "Hidden after revocation" });
  const revokedStream = await streamRequest(viewer.headers, revokedStreamInput);
  const revokedReader = revokedStream.body!.getReader(); const revokedFrames = new SseDecoder(); const revokedEvents: any[] = [];
  while (!revokedEvents.some(event => event.type === "text")) {
    const chunk = await revokedReader.read(); assert.equal(chunk.done, false);
    revokedEvents.push(...revokedFrames.push(decoded.decode(chunk.value, { stream: true })).map((frame: string) => JSON.parse(frame)));
  }
  await runtime.identity.removeMembership(owner.headers, project.id, viewer.actor.id);
  releaseStream();
  while (true) { const chunk = await revokedReader.read(); if (chunk.done) break; revokedEvents.push(...revokedFrames.push(decoded.decode(chunk.value, { stream: true })).map((frame: string) => JSON.parse(frame))); }
  assert(revokedEvents.some(event => event.type === "failed"));
  assert(!JSON.stringify(revokedEvents).includes("Hidden after revocation"));
  assert(!revokedEvents.some(event => event.type === "completed"));
  await runtime.identity.setMembership(owner.headers, project.id, viewer.actor.id, { role: "viewer" });
  assert.equal((await createAssistantService(viewer.context).getMessageResult(db, { requestId: revokedStreamInput.requestId })).status, "failed");
  const detachedInput = { ...input, requestId: randomUUID(), message: "Recover after the display disconnects" };
  pauseStream = () => new Promise<void>(resolve => { releaseStream = resolve; });
  modelReplies.push({ content: "Detached preview ".padEnd(64, ".") + "Completed original request" });
  const detached = await streamRequest(owner.headers, detachedInput); const detachedReader = detached.body!.getReader();
  const detachedFrames = new SseDecoder(); let sawText = false;
  while (!sawText) { const chunk = await detachedReader.read(); assert.equal(chunk.done, false); sawText = detachedFrames.push(decoded.decode(chunk.value, { stream: true })).some((frame: string) => JSON.parse(frame).type === "text"); }
  await detachedReader.cancel(); releaseStream();
  let detachedResult: any;
  for (let attempt = 0; attempt < 30; attempt++) { detachedResult = await ownerChat.getMessageResult(db, { requestId: detachedInput.requestId }); if (detachedResult.status === "completed") break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(detachedResult.status, "completed"); assert(detachedResult.result.assistantMessage.content.includes("Completed original request"));


  await assert.rejects(db.insert(assistantMessages).values({ ...sent.userMessage, id: randomUUID() }),
    (error: any) => (error.cause?.code ?? error.code) === "23505");
  const recovered = await rest(`assistant/messages/${messageRequestId}/result`, owner.headers);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.status, "completed");
  assert.equal(recovered.body.result.assistantMessage.id, sent.assistantMessage.id);
  const foreignResult = await rest(`assistant/messages/${messageRequestId}/result`, outsider.headers);
  assert.deepEqual(foreignResult.body, { status: "not_found", result: null, progress: null });

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
  for (let round = 0; round < 16; round++) modelReplies.push({ content: null, tool_calls: [toolCall("list_projects", {})] });
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ message: "Unbounded query fixture", context: {} })), /query limit reached/);
  assert.equal(calls - beforeLoop, 16);
  assert.equal(lastModelPayload.tool_choice, "none");
  const proposed = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "update_task", payload: { taskId: task.id, title: "Reviewed task" } }] }));
  const action = proposed.actions[0];
  assert.ok(action);
  await assert.rejects(outsiderChat.executeApprovedAction(db, action.id), NotFoundError);
  await assert.rejects(ownerChat.updateActionStatus(db, action.id, { status: "succeeded", executionResult: { forged: true } }), AuthorizationError);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  const concurrentApproval = await Promise.allSettled([ownerChat.executeApprovedAction(db, action.id), ownerChat.executeApprovedAction(db, action.id)]);
  assert.equal(concurrentApproval.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(concurrentApproval.filter(result => result.status === "rejected").length, 1);
  const executed = concurrentApproval.find(result => result.status === "fulfilled")!.value;
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
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "confirm" });
  modelReplies.push({ content: null, tool_calls: [toolCall("create_requirement", { projectId: project.id, title: "Confirmed natural requirement" })] });
  const confirmation = await rest("assistant/chat", owner.headers, "POST", { message: "Create a requirement after asking me", context: { projectId: project.id } });
  assert.equal(confirmation.status, 201);
  assert.equal(confirmation.body.actions.length, 1);
  const pending = confirmation.body.actions[0];
  assert.equal(pending.status, "proposed");
  assert.equal(pending.executionResult, null);
  assert(!(await owner.service.requirementService.listRequirements(db, { projectId: project.id })).some((row: any) => row.title === "Confirmed natural requirement"));
  const rawAssistant = apiRequire("@task-weaver/core").assistantService;
  await assert.rejects(() => rawAssistant.executeApprovedAction(db, pending.id, owner.actor, owner.context, true), AuthorizationError);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  assert.equal((await rest(`assistant/actions/${pending.id}/execute`, owner.headers, "POST")).status, 403);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: true });
  assert.equal((await rest(`assistant/actions/${pending.id}/execute`, outsider.headers, "POST")).status, 404);
  const approved = await rest(`assistant/actions/${pending.id}/execute`, owner.headers, "POST");
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "succeeded");
  assert.equal((await owner.service.requirementService.getRequirement(db, approved.body.executionResult.entityId)).title, "Confirmed natural requirement");
  assert.equal((await rest(`assistant/actions/${pending.id}/execute`, owner.headers, "POST")).status, 400);
  await ownerChat.updatePolicy(db, { assistantAutoMode: "live", assistantActionAllowlist: [] });
  const empty = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ ...input, proposedActions: [{ actionType: "add_comment", payload: { taskId: task.id, content: "Blocked fixture comment" } }] }));
  assert.equal(empty.actions[0].status, "succeeded");
  assert.equal(empty.actions[0].executionResult.result.content, "Blocked fixture comment");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("create_requirement", { projectId: project.id, title: "Chat-created requirement" })] },
    { content: "Requirement created through a real authorized operation" },
  );
  const naturalRequirement = await rest("assistant/chat", owner.headers, "POST", { message: "Create a requirement for the project", context: { projectId: project.id } });
  assert.equal(naturalRequirement.status, 201);
  assert.equal(naturalRequirement.body.actions[0].status, "succeeded");
  const createdRequirementId = naturalRequirement.body.actions[0].executionResult.entityId;
  assert.equal((await owner.service.requirementService.getRequirement(db, createdRequirementId)).title, "Chat-created requirement");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("create_task", { projectId: project.id, requirementId: createdRequirementId, title: "Chat-created task" })] },
    { content: "Task created through a real authorized operation" },
  );
  const naturalTask = await rest("assistant/chat", owner.headers, "POST", { message: "Create its first task", context: { projectId: project.id, requirementId: createdRequirementId } });
  assert.equal(naturalTask.status, 201);
  assert.equal(naturalTask.body.actions[0].status, "succeeded");
  const createdTaskId = naturalTask.body.actions[0].executionResult.entityId;
  assert.equal((await owner.service.taskService.getTask(db, createdTaskId)).requirementId, createdRequirementId);
  const invalidAssignment = { projectId: project.id, requirementId: createdRequirementId, title: "Invalid assignment", assignee: "null" };
  modelReplies.push(
    { content: null, tool_calls: [toolCall("create_task", invalidAssignment)] },
    { content: null, tool_calls: [toolCall("create_task", { assignee: "null", title: "Invalid assignment", requirementId: createdRequirementId, projectId: project.id })] },
    { content: "The invalid assignee must be omitted before retrying" },
  );
  const invalidTask = await rest("assistant/chat", owner.headers, "POST", { message: "Create an unassigned task", context: { projectId: project.id } });
  assert.equal(invalidTask.status, 201);
  assert.equal(invalidTask.body.actions.length, 1);
  assert.equal(invalidTask.body.actions[0].status, "failed");
  assert.match(invalidTask.body.actions[0].errorMessage, /omit assignee and assigneeType/);
  modelReplies.push(
    { content: null, tool_calls: [toolCall("add_task_dependency", { taskId: createdTaskId, dependsOnTaskId: task.id, type: "blocks" })] },
    { content: "Dependency created" },
  );
  const orchestrated = await rest("assistant/chat", owner.headers, "POST", { message: "Make it depend on the existing task", context: { projectId: project.id } });
  assert.equal(orchestrated.status, 201);
  assert.equal(orchestrated.body.actions[0].status, "succeeded");
  modelReplies.push(
    { content: null, tool_calls: [toolCall("create_execution_slice", { requirementId: createdRequirementId, title: "Chat execution plan", taskIds: [createdTaskId], allowParallel: false })] },
    { content: "Execution slice created" },
  );
  const sliceOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Put the task in an ordered execution slice", context: { projectId: project.id } });
  assert.equal(sliceOperation.status, 201);
  assert.equal(sliceOperation.body.actions[0].status, "succeeded");
  assert.equal((await owner.service.requirementService.listExecutionSlices(db, createdRequirementId))[0].title, "Chat execution plan");
  const directory = await mkdtemp(join(tmpdir(), "tw-chat-assets-"));
  const previousStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
  process.env.SKILL_PACKAGE_STORAGE_DIR = directory;
  t.after(async () => { if (previousStorage === undefined) delete process.env.SKILL_PACKAGE_STORAGE_DIR; else process.env.SKILL_PACKAGE_STORAGE_DIR = previousStorage; await rm(directory, { recursive: true, force: true }); });
  const readTools = apiRequire("../../packages/core/src/services/assistant-read-tools.ts");
  const pool = apiRequire("../../packages/core/src/services/mcp-pool.ts").mcpPool;
  const operationCatalog = apiRequire("../../packages/core/src/services/assistant-operations.ts").assistantOperations;
  assert(!Object.keys(operationCatalog).some(name => /repository|membership|shell|partners/.test(name)));
  const chatOperation = async (name: string, args: Record<string, unknown>, existingConversationId?: string) => {
    modelReplies.push({ content: null, tool_calls: [toolCall(name, args)] }, { content: "Requested operation completed" });
    const response = await rest("assistant/chat", owner.headers, "POST", { message: "Perform " + name, ...(existingConversationId ? { conversationId: existingConversationId } : {}), context: existingConversationId ? {} : { projectId: project.id } });
    assert.equal(response.status, 201);
    return response.body;
  };
  const memorySaved = await chatOperation("record_memory", { title: "Chat memory fixture", content: "Use short project updates", memoryType: "user" });
  assert.equal(memorySaved.actions[0].status, "succeeded");
  const memoryId = memorySaved.actions[0].executionResult.entityId;
  assert.equal((await owner.service.memoryService.getMemory(db, memoryId)).personalOwnerId, owner.actor.id);
  const memoryRead = await readTools.runAssistantReadTool(db, owner.context, "search_memories", { query: "Chat memory fixture" });
  assert(memoryRead.data.some((row: any) => row.id === memoryId));
  await assert.rejects(readTools.runAssistantReadTool(db, outsider.context, "get_memory", { memoryId }));
  const personalTask = await owner.service.taskService.createPersonalTask(db, { title: "Chat personal fixture" }, owner.actor);
  assert((await readTools.runAssistantReadTool(db, owner.context, "list_personal_tasks", { query: "Chat personal fixture" })).data.items.some((row: any) => row.id === personalTask.id));
  assert.equal((await readTools.runAssistantReadTool(db, outsider.context, "list_personal_tasks", { query: "Chat personal fixture" })).data.items.length, 0);
  const savedSkill = await chatOperation("save_skill", { name: "Chat skill fixture", version: "1.0.0", files: [{ path: "SKILL.md", content: "# Fixture\nRead guide.md and use concise status updates. Do not perform unrelated operations." }, { path: "guide.md", content: "Verified guide content" }] });
  assert.equal(savedSkill.actions[0].status, "succeeded");
  const packageId = savedSkill.actions[0].executionResult.entityId;
  const loadedSkill = await readTools.runAssistantReadTool(db, owner.context, "load_skill", { packageId });
  assert.match(loadedSkill.data.content, /Read guide.md/);
  assert(loadedSkill.references.some((reference: any) => reference.kind === "package" && reference.id === packageId));
  assert.equal((await readTools.runAssistantReadTool(db, owner.context, "read_skill_file", { packageId, path: "guide.md" })).data.content, "Verified guide content");
  await assert.rejects(readTools.runAssistantReadTool(db, owner.context, "read_skill_file", { packageId, path: "../secret" }));
  await assert.rejects(readTools.runAssistantReadTool(db, outsider.context, "load_skill", { packageId }));
  assert.equal((await readTools.runAssistantReadTool(db, owner.context, "list_skills", { query: "Chat skill fixture" })).data.items[0].id, packageId);
  assert.equal((await readTools.runAssistantReadTool(db, owner.context, "list_skills", { query: "No matching fixture" })).data.items.length, 0);
  await chatOperation("update_skill", { packageId, status: "archived" });
  await assert.rejects(readTools.runAssistantReadTool(db, owner.context, "load_skill", { packageId }), /active/);
  await chatOperation("update_skill", { packageId, status: "active" });
  modelReplies.push({ content: null, tool_calls: [toolCall("load_skill", { packageId }), toolCall("get_memory", { memoryId })] }, { content: "Used the loaded skill and account memory" });
  const loadedConversation = await rest("assistant/chat", owner.headers, "POST", { message: "Load and use my skill and memory", context: {} });
  assert.equal(loadedConversation.status, 201);
  assert(loadedConversation.body.userMessage.contextSnapshot.toolReads.some((reference: any) => reference.kind === "package"));
  await chatOperation("update_memory", { memoryId, changes: { content: "Revised concise updates" } });
  assert.equal((await owner.service.memoryService.getMemory(db, memoryId)).content, "Revised concise updates");

  let mcpCalls = 0;
  let hold = false;
  let releaseCall: (() => void) | undefined;
  let enteredCall: (() => void) | undefined;
  const credential = "fixture-private-mcp-header";
  const remoteMcp = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: any = {};
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "chat-fixture", version: "1" } };
    if (body.method === "tools/list") result = { tools: [{ name: "fixture_echo", description: "Echo a fixture message", inputSchema: { type: "object", properties: { message: { type: "string" }, config: { type: "string" }, data: { type: "string" } }, required: ["message"] } }] };
    if (body.method === "tools/call") {
      mcpCalls++;
      enteredCall?.();
      if (hold) await new Promise<void>(resolve => { releaseCall = resolve; });
      result = { isError: body.params.arguments.message === "fail", content: [{ type: "text", text: "Fixture " + body.params.arguments.message + " " + credential }], structuredContent: { data: { message: body.params.arguments.message } } };
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  remoteMcp.listen(0, "127.0.0.1"); await once(remoteMcp, "listening");
  t.after(async () => { await pool.disconnectAll(); pool.stopIdleReaper(); remoteMcp.closeAllConnections(); await new Promise<void>(resolve => remoteMcp.close(() => resolve())); });
  const port = (remoteMcp.address() as { port: number }).port;
  const mcpServer = await owner.service.mcpRegistryService.registerServer(db, registerMcpServerSchema.parse({ name: "Chat remote fixture", personalOwnerId: owner.actor.id, personalOwnerType: "human", transport: "streamable-http", config: { url: `http://127.0.0.1:${port}`, headers: { "X-Fixture-Token": credential } } }), owner.actor);
  const synced = await chatOperation("sync_mcp_tools", { serverId: mcpServer.id });
  assert.equal(synced.actions[0].status, "succeeded");
  const foundTools = await readTools.runAssistantReadTool(db, owner.context, "search_mcp_tools", { intent: "fixture_echo" });
  const mcpToolId = foundTools.data[0].id;
  const inspectedTool = await readTools.runAssistantReadTool(db, owner.context, "get_mcp_tool", { toolId: mcpToolId });
  assert(inspectedTool.data.inputSchema.properties.config);
  assert(inspectedTool.data.inputSchema.properties.data);
  assert(!JSON.stringify(await readTools.runAssistantReadTool(db, owner.context, "get_mcp_server", { serverId: mcpServer.id })).includes(credential));
  await assert.rejects(readTools.runAssistantReadTool(db, outsider.context, "get_mcp_tool", { toolId: mcpToolId }));
  await ownerChat.updatePolicy(db, { assistantAutoMode: "confirm" });
  modelReplies.push({ content: null, tool_calls: [toolCall("call_mcp_tool", { toolId: mcpToolId, arguments: { message: "confirmed" } })] });
  const mcpProposal = await rest("assistant/chat", owner.headers, "POST", { message: "Call the fixture after I approve", context: {} });
  assert.equal(mcpProposal.body.actions[0].status, "proposed"); assert.equal(mcpCalls, 0);
  const confirmedMcp = await rest(`assistant/actions/${mcpProposal.body.actions[0].id}/execute`, owner.headers, "POST");
  assert.equal(confirmedMcp.status, 200); assert.equal(mcpCalls, 1);
  assert(!JSON.stringify(confirmedMcp.body).includes(credential));
  assert.equal(confirmedMcp.body.executionResult.result.output.structuredContent.data.message, "confirmed");
  assert.equal((await rest(`assistant/actions/${mcpProposal.body.actions[0].id}/execute`, owner.headers, "POST")).status, 400);
  await ownerChat.updatePolicy(db, { assistantAutoMode: "live" });
  hold = true;
  const entered = new Promise<void>(resolve => { enteredCall = resolve; });
  const liveRequest = randomUUID();
  modelReplies.push({ content: null, tool_calls: [toolCall("call_mcp_tool", { toolId: mcpToolId, arguments: { message: "progress" } })] }, { content: "External result received" });
  const inFlight = rest("assistant/chat", owner.headers, "POST", { requestId: liveRequest, message: "Call and show progress", context: {} });
  await entered;
  const progress = await rest(`assistant/messages/${liveRequest}/result`, owner.headers);
  assert.equal(progress.body.status, "running"); assert.equal(progress.body.progress.actions[0].status, "executing");
  assert.equal((await rest(`assistant/actions/${progress.body.progress.actions[0].id}/execute`, owner.headers, "POST")).status, 400);
  releaseCall!(); hold = false;
  assert.equal((await inFlight).body.actions[0].status, "succeeded"); assert.equal(mcpCalls, 2);
  modelReplies.push({ content: null, tool_calls: [toolCall("call_mcp_tool", { toolId: mcpToolId, arguments: { message: "fail" } })] }, { content: null, tool_calls: [toolCall("call_mcp_tool", { toolId: mcpToolId, arguments: { message: "changed retry" } })] }, { content: "The external result is uncertain; inspect it before retrying" });
  const failedMcp = await rest("assistant/chat", owner.headers, "POST", { message: "Exercise one external failure", context: {} });
  assert.equal(failedMcp.body.actions.length, 1); assert.equal(failedMcp.body.actions[0].status, "failed"); assert.equal(mcpCalls, 3);
  assert.match(failedMcp.body.actions[0].errorMessage, /Do not retry automatically/);
  await chatOperation("update_mcp_server", { serverId: mcpServer.id, changes: { name: "Renamed fixture" } });
  assert.equal((await owner.service.mcpRegistryService.getServer(db, mcpServer.id)).name, "Renamed fixture");
  const memoryDeleted = await chatOperation("forget_memory", { memoryId }, loadedConversation.body.conversation.id);
  assert.equal(memoryDeleted.actions[0].status, "succeeded");
  assert.equal((await rest(`assistant/conversations/${memoryDeleted.conversation.id}`, owner.headers)).status, 200);
  const mcpDeleted = await chatOperation("delete_mcp_server", { serverId: mcpServer.id }, mcpProposal.body.conversation.id);
  assert.equal(mcpDeleted.actions[0].status, "succeeded");
  assert.equal((await rest(`assistant/conversations/${mcpDeleted.conversation.id}`, owner.headers)).status, 200);
  const scheduleRead = await readTools.runAssistantReadTool(db, owner.context, "get_schedule", { scheduleId });
  assert.equal(scheduleRead.data.id, scheduleId);
  assert(scheduleRead.references.some((reference: any) => reference.kind === "schedule" && reference.id === scheduleId));
  await assert.rejects(readTools.runAssistantReadTool(db, outsider.context, "get_schedule", { scheduleId }));
  await readTools.runAssistantReadTool(db, owner.context, "list_schedules", {});
  await readTools.runAssistantReadTool(db, owner.context, "list_schedule_runs", { scheduleId });
  await readTools.runAssistantReadTool(db, owner.context, "list_ti_runs", {});
  await readTools.runAssistantReadTool(db, owner.context, "get_requirement_run_history", { requirementId: requirement.id });
  await assert.rejects(readTools.runAssistantReadTool(db, outsider.context, "get_requirement_run_history", { requirementId: requirement.id }));
  modelReplies.push({ content: null, tool_calls: [toolCall("create_requirement", { projectId: other.id, title: "Unauthorized requirement" })] });
  const foreignOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Attempt a foreign project write", context: {} });
  assert.equal(foreignOperation.status, 403);
  assert.equal((await outsider.service.requirementService.listRequirements(db, { projectId: other.id })).length, 1);
  await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  modelReplies.push({ content: null, tool_calls: [toolCall("create_requirement", { projectId: project.id, title: "Forbidden requirement" })] }, { content: "Operations are disabled" });
  const deniedOperation = await rest("assistant/chat", owner.headers, "POST", { message: "Create while disabled", context: { projectId: project.id } });
  assert.equal(deniedOperation.status, 201);
  assert.equal(deniedOperation.body.actions.length, 0);
  assert.ok(lastModelPayload.tools.every((tool: any) => !tool.function.name.startsWith("create_")));
  const failedRequestId = randomUUID();
  modelReplies.push({ content: "<｜DSML｜function_calls>invalid provider tool markup" });
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, { ...input, requestId: failedRequestId }), /invalid tool response/);
  assert.equal((await ownerChat.getMessageResult(db, { requestId: failedRequestId })).status, "failed");
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
  expectedKey = ""; responseStatus = 401;
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, input), /Model rejected/);
  assert.equal(calls, beforeMissing + 1);
  expectedKey = "fixture-personal-key"; responseStatus = 200;
  await ownerModels.save(db, { ...modelSettings, apiKey: "fixture-personal-key" });
  await ownerModels.test(db, savedModel.id);
  await ownerModels.save(db, { provider: "fixture", model: "fixture-chat", apiKey: "fixture-replaced-key" });
  expectedKey = "fixture-replaced-key";
  const replaced = await ownerChat.sendReadOnlyMessage(db, input);
  assert.equal(replaced.assistantMessage.content, "Fixture model reply");
  const beforePrivate = calls;
  dnsAddress = "127.0.0.1";
  await ownerModels.test(db, savedModel.id);
  assert.equal(calls, beforePrivate + 1);
  dnsAddress = "8.8.8.8";
  responseStatus = 302;
  await assert.rejects(ownerModels.test(db, savedModel.id), error => error instanceof Error && !error.message.includes(expectedKey) && /Model request failed/.test(error.message));
  responseStatus = 200;
  await t.test("arbitrary providers resolve and test without a saved API key over local HTTP", async () => {
    const localModel = createServer((req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, undefined);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
    localModel.listen(0, "127.0.0.1"); await once(localModel, "listening");
    try {
      dnsAddress = "127.0.0.1";
      const port = (localModel.address() as { port: number }).port;
      const local = await ownerModels.save(db, { provider: "ollama-local", model: "local-fixture", baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true });
      assert.equal(local.hasApiKey, false); assert.equal(local.requiresKeyEntry, false);
      assert.equal(local.proxyMode, "inherit"); assert.equal(local.proxyUrl, null);
      const proxy = createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "Proxy OK" } }] }));
      });
      proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
      try {
        const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        await ownerModels.save(db, { provider: "ollama-local", model: "local-fixture", proxyMode: "custom", proxyUrl });
        await ownerModels.save(db, { provider: "ollama-local", model: "local-fixture", label: "Proxy preserved" });
        const resolved = await ownerModels.resolve(db, "ollama-local", "local-fixture");
        assert.equal(resolved.config.proxyMode, "custom"); assert.equal(resolved.config.proxyUrl, proxyUrl);
        assert.equal((await ownerModels.list(db)).find((m: any) => m.id === local.id).proxyUrl, proxyUrl);
        assert(!(await createChatModelService(outsider.context).list(db)).some((m: any) => m.id === local.id));
        await ownerModels.test(db, local.id);
        await ownerModels.save(db, { provider: "ollama-local", model: "local-fixture", proxyMode: "direct" });
        const direct = await ownerModels.resolve(db, "ollama-local", "local-fixture");
        assert.equal(direct.config.proxyMode, "direct"); assert.equal(direct.config.proxyUrl, null);
      } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
      assert.equal((await ownerModels.resolve(db, "ollama-local", "local-fixture")).apiKey, "");
      await ownerModels.test(db, local.id);
      await ownerModels.deleteKey(db, local.id);
      await ownerModels.resolve(db, "ollama-local", "local-fixture");
      await assert.rejects(createChatModelService(outsider.context).test(db, local.id), NotFoundError);
    } finally { dnsAddress = "8.8.8.8"; localModel.closeAllConnections(); await new Promise<void>(resolve => localModel.close(() => resolve())); }
  });
  const legacyId = randomUUID();
  await db.insert(tiAgentModelConfigs).values({ id: legacyId, ownerId: owner.actor.id, ownerType: "human", provider: "legacy", model: "legacy-chat", baseUrl: "https://model.example.test/v1", apiKeyRef: "FIXTURE_CHAT_UPGRADE_KEY", credentialStatus: "unknown", enabled: true });
  process.env.FIXTURE_CHAT_UPGRADE_KEY = "fixture-never-imported";
  t.after(() => { delete process.env.FIXTURE_CHAT_UPGRADE_KEY; });
  const beforeLegacy = calls;
  expectedKey = ""; responseStatus = 401;
  await assert.rejects(ownerChat.sendReadOnlyMessage(db, { ...input, requestedProvider: "legacy", requestedModel: "legacy-chat" }), /Model rejected/);
  assert.equal(calls, beforeLegacy + 1);
  expectedKey = "fixture-replaced-key"; responseStatus = 200;
  const legacy = (await ownerModels.list(db)).find((row: any) => row.id === legacyId);
  assert.equal(legacy.baseUrl, "https://model.example.test/v1");
  assert.equal(legacy.requiresKeyEntry, false);
  const safeTi = await rest("ti/configs?includeDisabled=true", owner.headers);
  assert.equal(safeTi.status, 200);
  assert.ok(!JSON.stringify(safeTi.body).includes("encryptedApiKey"));
  assert.ok(!JSON.stringify(safeTi.body).includes(expectedKey));
  await t.test("archiving a project completes streaming and preserves authorized history", async () => {
    expectedKey = "fixture-replaced-key";
    const archived = await owner.service.projectService.createProject(db, { name: "Archive Chat fixture" }, owner.actor);
    const archiveRequirement = await owner.service.requirementService.createRequirement(db, { projectId: archived.id, title: "History requirement" }, owner.actor);
    const projectHistory = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ message: "Read project before archiving", context: { projectId: archived.id } }));
    const issued = await apiKeyService.issueScopedApiKey(db, owner.context, owner.actor.id, { name: "History read fixture", grants: [
      { scope: "personal", actorId: owner.actor.id, permissions: ["resource.read"] },
      { scope: "project", projectId: archived.id, permissions: ["resource.read"] },
      { scope: "project", projectId: project.id, permissions: ["resource.read"] },
    ], expiresAt: null });
    const keyIdentity = await runtime.verify(new Headers({ authorization: `Bearer ${issued.rawKey}` }));
    const restricted = await apiKeyService.issueScopedApiKey(db, owner.context, owner.actor.id, { name: "Personal history only", grants: [
      { scope: "personal", actorId: owner.actor.id, permissions: ["resource.read"] },
    ], expiresAt: null });
    const restrictedIdentity = await runtime.verify(new Headers({ authorization: `Bearer ${restricted.rawKey}` }));
    await ownerChat.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
    const requestId = randomUUID();
    modelReplies.push({ content: null, tool_calls: [toolCall("archive_project", { projectId: archived.id })] }, { content: "Project archived successfully" });
    const response = await streamRequest(owner.headers, { requestId, message: "Archive the empty fixture project", context: {} });
    assert.equal(response.status, 200);
    const frames = new SseDecoder().push(await response.text()).map((frame: string) => JSON.parse(frame));
    const completed = frames.find((event: any) => event.type === "completed");
    assert(completed, JSON.stringify(frames.filter((event: any) => event.type === "error")));
    assert.equal(completed.result.actions[0].status, "succeeded");
    assert.equal((await ownerChat.getMessageResult(db, { requestId })).status, "completed");
    assert.equal((await ownerChat.getConversation(db, completed.result.conversation.id)).messages.at(-1).content, "Project archived successfully");
    assert.equal((await ownerChat.getConversation(db, projectHistory.conversation.id)).conversation.id, projectHistory.conversation.id);
    assert.equal((await createAssistantService(keyIdentity).getConversation(db, projectHistory.conversation.id)).conversation.id, projectHistory.conversation.id);
    assert((await ownerChat.listConversations(db, { projectId: archived.id })).some((row: any) => row.id === projectHistory.conversation.id));
    await assert.rejects(createAssistantService(restrictedIdentity).getConversation(db, projectHistory.conversation.id), NotFoundError);
    await assert.rejects(outsiderChat.getConversation(db, completed.result.conversation.id), NotFoundError);
    await assert.rejects(owner.service.requirementService.getRequirement(db, archiveRequirement.id), NotFoundError);
    await assert.rejects(owner.service.projectService.updateProject(db, archived.id, { name: "Forbidden live change" }, owner.actor), NotFoundError);
    await assert.rejects(ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ conversationId: projectHistory.conversation.id, message: "Continue in archived scope", context: { projectId: archived.id } })), NotFoundError);
    modelReplies.push({ content: "Global conversation continues after archival" });
    const continued = await ownerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ conversationId: completed.result.conversation.id, message: "Continue globally", context: {} }));
    assert.equal(continued.assistantMessage.content, "Global conversation continues after archival");
    const scopedArchive = await owner.service.projectService.createProject(db, { name: "Scoped archive fixture" }, owner.actor);
    modelReplies.push({ content: null, tool_calls: [toolCall("archive_project", { projectId: scopedArchive.id })] }, { content: "Current project archived" });
    const scopedResponse = await streamRequest(owner.headers, { requestId: randomUUID(), message: "Archive this project", context: { projectId: scopedArchive.id } });
    const scopedCompleted = new SseDecoder().push(await scopedResponse.text()).map((frame: string) => JSON.parse(frame)).find((event: any) => event.type === "completed");
    assert(scopedCompleted);
    assert.equal(scopedCompleted.result.actions[0].status, "succeeded");
    assert.equal((await ownerChat.getConversation(db, scopedCompleted.result.conversation.id)).conversation.projectId, scopedArchive.id);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, issued.id));
    await assert.rejects(createAssistantService(keyIdentity).getConversation(db, projectHistory.conversation.id));
    await db.update(projectMemberships).set({ removedAt: new Date() }).where(eq(projectMemberships.projectId, archived.id));
    await assert.rejects(ownerChat.getConversation(db, projectHistory.conversation.id), NotFoundError);
    await assert.rejects(ownerChat.getConversation(db, completed.result.conversation.id), NotFoundError);
    await ownerChat.updatePolicy(db, { assistantAutoEnabled: false });
  });
  expectedKey = "fixture-personal-key";
  const viewerRequestId = randomUUID();
  const viewerGlobal = await viewerChat.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ requestId: viewerRequestId, message: "List my projects", context: {} }));
  await runtime.identity.removeMembership(owner.headers, project.id, viewer.actor.id);
  await assert.rejects(viewerChat.getConversation(db, viewerGlobal.conversation.id), NotFoundError);
  await assert.rejects(viewerChat.getMessageResult(db, { requestId: viewerRequestId }), NotFoundError);
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
