import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { executeTiTaskAttempt } from "../packages/core/src/services/ti-task-runtime";
import { createTiSandboxAuthority } from "../packages/core/src/services/ti-sandbox-authorization";
import { createTiSandboxService } from "../packages/core/src/services/ti-sandboxes";
import { configuredTiSandboxBinding } from "../packages/core/src/services/ti-sandbox-tools";
import { createTiSandboxCleanup } from "../packages/core/src/services/ti-sandbox-cleanup";
import { encryptChatKey, chatKeyBinding } from "../packages/core/src/services/chat-credentials";
import { mcpPool } from "../packages/core/src/services/mcp-pool";
import { LocalSkillPackageStorageAdapter } from "../packages/core/src/services/skill-package-storage";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const coreRequire = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { Server } = coreRequire("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = coreRequire("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = coreRequire("@modelcontextprotocol/sdk/types.js");
const { createDb, runMigrations, authInstanceState, authRateLimits, tiAgentModelConfigs, tiAgentPolicies, tiAgentRuns,
  tiSandboxWorkspaces: w, tiSandboxOperations: o, assistantConversations } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createTiExecutionService, apiKeyService, registerSkillPackageSchema,
  createAssistantService, sendAssistantMessageSchema } = apiRequire("@task-weaver/core");
const { eq, and, like, ne } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_TI_LIVE_DATABASE_URL;
const enabled = !!databaseUrl && !!process.env.TW_TI_REAL_MODEL_URL && !!process.env.PARTNERS_MCP_URL;

test("actual model uses platform skills, memories, HTTP MCP and remote owned sandboxes", { skip: !enabled, timeout: 1_200_000 }, async t => {
  assert.equal(new URL(databaseUrl!).hostname, "127.0.0.1");
  assert.equal(new URL(databaseUrl!).pathname, "/tw_ti_live_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);

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
  const project = await owner.service.projectService.createProject(db, { name: "Shared runtime remote acceptance" }, owner.actor);
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Runtime evidence", status: "approved" }, owner.actor);
  await runtime.identity.setMembership(owner.headers, project.id, outsider.actor.id, { role: "owner" });
  await runtime.identity.setMembership(outsider.headers, project.id, owner.actor.id, { role: "owner", explicitPermissions: ["mcp.invoke"] });
  const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Acceptance executor" });
  await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "mcp.invoke"] });

  const issued = await apiKeyService.issueScopedApiKey(db, owner.context, agent.id, { name: "Acceptance worker", grants: [{ scope: "project", projectId: project.id,
    permissions: ["resource.read", "resource.write", "execution.run", "mcp.invoke"] }], expiresAt: null });
  const executor = await runtime.verify(new Headers({ authorization: `Bearer ${issued.rawKey}` }));
  process.env.TW_CHAT_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64");
  const provider = "acceptance-real", model = process.env.TW_TI_REAL_MODEL_NAME!;
  await db.insert(tiAgentModelConfigs).values({ ownerId: owner.actor.id, ownerType: "human", provider, model,
    baseUrl: process.env.TW_TI_REAL_MODEL_URL, proxyMode: "direct", enabled: true, isDefaultAgent: true, isDefaultChat: true,
    encryptedApiKey: encryptChatKey(process.env.TW_TI_REAL_MODEL_KEY!, chatKeyBinding({ ownerId: owner.actor.id, provider, model })), credentialStatus: "valid" });
  await db.insert(tiAgentPolicies).values({ ownerId: owner.actor.id, ownerType: "human", enabled: true, executionMode: "live", allowNetwork: true,
    runTimeoutSeconds: 600, allowedTools: ["get_task", "list_skills", "load_skill", "get_memory", "search_mcp_tools", "get_mcp_tool", "call_mcp_tool", "sandbox_write", "sandbox_exec", "sandbox_job", "sandbox_read", "add_comment"], assistantAutoEnabled: true, assistantAutoMode: "confirm", assistantActionAllowlist: ["platform_operation"] });
  const binding = configuredTiSandboxBinding();
  const cleanup = createTiSandboxCleanup(db, async id => { assert.equal(id, binding.id); return binding; });
  const localStorage = await mkdtemp(join(tmpdir(), "tw-runtime-skills-"));
  const priorStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
  process.env.SKILL_PACKAGE_STORAGE_DIR = localStorage;
  t.after(async () => { process.env.SKILL_PACKAGE_STORAGE_DIR = priorStorage; await rm(localStorage, { recursive: true, force: true }); });
  const skillMarker = `SKILL-${randomUUID()}`, memoryMarker = `MEMORY-${randomUUID()}`, mcpMarker = `MCP-${randomUUID()}`;
  const skillName = `Runtime proof ${randomUUID()}`;
  await owner.service.skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ name: skillName, version: "1.0.0", projectId: project.id,
    sourceType: "directory", files: [{ path: "SKILL.md", kind: "entry", isReadableText: true, contentType: "text/markdown",
      contentBase64: Buffer.from(`# Runtime proof\nThe skill marker for the assigned task is ${skillMarker}. Read platform memory and the proof MCP tool to obtain the other two markers. Only perform the assigned proof task.\n`).toString("base64") }] }), owner.actor, new LocalSkillPackageStorageAdapter(localStorage));
  const memory = await owner.service.memoryService.recordMemory(db, { projectId: project.id, title: "Runtime proof memory", content: `The memory marker is ${memoryMarker}.`, memoryType: "reference" }, owner.actor);
  const httpToken = randomBytes(24).toString("hex");
  let mcpCalls = 0;
  const httpMcp = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${httpToken}`) { response.writeHead(401); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const server = new Server({ name: "acceptance-proof-reader", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup_acceptance_proof", description: "Read the MCP marker for runtime acceptance", inputSchema: { type: "object", properties: { key: { type: "string", enum: ["proof"] } }, required: ["key"], additionalProperties: false }, annotations: { readOnlyHint: true } }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }: any) => {
      assert.equal(params.name, "lookup_acceptance_proof"); assert.equal(params.arguments.key, "proof"); mcpCalls++;
      return { content: [{ type: "text", text: JSON.stringify({ marker: mcpMarker }) }], structuredContent: { marker: mcpMarker } };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(request, response, JSON.parse(Buffer.concat(chunks).toString())); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => httpMcp.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await mcpPool.disconnectAll(); httpMcp.closeAllConnections(); await new Promise<void>(resolve => httpMcp.close(() => resolve())); });
  const address = httpMcp.address() as import("node:net").AddressInfo;
  const mcp = await owner.service.mcpRegistryService.registerServer(db, { name: "Runtime acceptance proof", projectId: project.id, transport: "streamable-http",
    config: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${httpToken}` } } }, owner.actor);
  await owner.service.mcpRegistryService.syncTools(db, mcp.id, mcpPool);
  const supervisor = createTiExecutionService(executor);
  const worker = { assignedAgentId: agent.id, workerId: `acceptance-${randomUUID()}`, durationMinutes: 15 };
  const createRun = async (description: string) => {
    const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Remote Ti proof", description,
      assignee: agent.id, assigneeType: "agent" }, owner.actor);
    await owner.service.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: "agent" }, owner.actor);
    const run = await supervisor.invoke(db, "acquireRun", [worker]);
    assert.equal(run.taskId, task.id);
    return { task, run, fence: { workerId: worker.workerId, leaseGeneration: run.leaseGeneration } };
  };
  const waitJob = async (sandbox: ReturnType<typeof createTiSandboxService>, key: string) => {
    let output = "", cursor = "0:0";
    for (let i = 0; i < 180; i++) {
      const page = await sandbox.getJob(key, { cursor }); output += page.stdout;
      const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(page.state);
      if (terminal && page.nextCursor === cursor) return { page, output };
      cursor = page.nextCursor;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Owned job did not terminate");
  };
  const reclaim = async (workspaceId: string) => {
    for (let i = 0; i < 80; i++) {
      const row = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, workspaceId) });
      if (row.state === "deleted") return;
      await db.update(w).set({ nextCleanupAt: new Date(0) }).where(eq(w.id, workspaceId));
      await cleanup.runOnce(); await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Owned workspace cleanup debt remains");
  };
  t.after(async () => {
    try {
    await db.update(w).set({ state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date() }).where(and(eq(w.bindingId, binding.id), eq(w.ownerId, owner.actor.id), ne(w.state, "deleted")));
    await db.update(w).set({ state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date() }).where(and(eq(w.bindingId, binding.id), eq(w.ownerId, outsider.actor.id), ne(w.state, "deleted")));
    for (let i = 0; i < 30 && await cleanup.runOnce(); i++) { /* Retain any failed cleanup as durable debt. */ }
    } finally { await mcpPool.disconnectAll(); await db.$client.end(); }
  });
  await t.test("a real model loads platform context and executes sandbox file/write/command/read through HTTP MCP", async () => {
    const { task, run, fence } = await createRun(`Read your assigned task. Discover and load skill '${skillName}' in project ${project.id}. Read memory ${memory.id}. Discover the HTTP MCP tool lookup_acceptance_proof, inspect its schema and call it with argumentsJson encoding {"key":"proof"}. Obtain the three opaque markers from those tools; join them in order skill|memory|MCP with no spaces. Use sandbox_write to create proof.txt with exactly that joined value, then sandbox_exec 'cat proof.txt' and poll sandbox_job until terminal; drain output. Read proof.txt using sandbox_read. Add exactly one comment on this assigned task containing only the joined value. Only report success after each step succeeds. Use concise tool calls, use at most four tool calls per turn, and do not invent any marker.`);
    let result;
    try { result = await executeTiTaskAttempt(db, executor, run.id, fence, binding, new AbortController().signal); }
    catch (error) { await supervisor.invoke(db, "completeRun", [run.id, { ...fence, status: "failed", errorMessage: "Acceptance attempt failed" }]); throw error; }
    assert.equal(result.status, "succeeded");
    assert.ok(mcpCalls > 0);
    const expected = `${skillMarker}|${memoryMarker}|${mcpMarker}`;
    const detail = await owner.service.taskService.getTaskDetail(db, task.id);
    assert.equal(detail.comments.filter((comment: any) => comment.content === expected).length, 1);
    const stored = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) });
    const checkpoint = JSON.stringify(stored.eventLog);
    for (const name of ["load_skill", "get_memory", "get_mcp_tool", "call_mcp_tool", "sandbox_write", "sandbox_exec", "sandbox_job", "sandbox_read"]) assert.ok(checkpoint.includes(name), name);
    await supervisor.invoke(db, "completeRun", [run.id, { ...result, ...fence }]);
    const workspace = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.runId, run.id) });
    assert.ok(workspace?.sessionId); await reclaim(workspace.id);
  });
  let chatScope: { conversationId: string; attempt: number }, chatSandbox: ReturnType<typeof createTiSandboxService>, chatWorkspace: any;
  await t.test("actual chat model proposes a sandbox command and waits for owner approval", async () => {
    const marker = `CHAT-${randomUUID()}`;
    const assistant = createAssistantService(owner.context);
    const result = await assistant.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ requestId: randomUUID(), requestedProvider: provider, requestedModel: model,
      context: { contextKind: "project", projectId: project.id }, message: `Propose exactly one sandbox_exec operation with command printf '${marker}' and timeoutSeconds 30. Do not use other tools or perform other changes. Wait for my approval.` }));
    const action = result.actions.find((action: any) => action.payload.operation === "sandbox_exec");
    assert.ok(action); assert.equal(action.status, "proposed");
    assert.equal((await db.select().from(w).where(eq(w.conversationId, result.conversation.id))).length, 0);
    await assistant.executeApprovedAction(db, action.id);
    chatScope = { conversationId: result.conversation.id, attempt: 1 };
    chatSandbox = createTiSandboxService(db, createTiSandboxAuthority(db, owner.context, chatScope), binding);
    assert.equal((await waitJob(chatSandbox, action.id)).output, marker);
    chatWorkspace = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.conversationId, chatScope.conversationId) });
    await assert.rejects(() => createTiSandboxAuthority(db, outsider.context, chatScope)());
  });
  await t.test("same-project foreign conversations and restarted clients cannot cross owned operation handles", async () => {
    const [conversation] = await db.insert(assistantConversations).values({ projectId: project.id, createdBy: outsider.actor.id, createdByType: "human" }).returning();
    const scope = { conversationId: conversation.id, attempt: 1 };
    const foreign = createTiSandboxService(db, createTiSandboxAuthority(db, outsider.context, scope), binding);
    await foreign.execute("foreign-command", { command: "printf other", timeoutSeconds: 30 });
    assert.equal((await waitJob(foreign, "foreign-command")).output, "other");
    if (chatSandbox) await assert.rejects(() => chatSandbox.getJob("foreign-command"));
    const once = `ONCE-${randomUUID()}`;
    await foreign.execute("once", { command: `printf '${once}' >> once.txt`, timeoutSeconds: 30 });
    const restarted = createTiSandboxService(db, createTiSandboxAuthority(db, outsider.context, scope), binding);
    await waitJob(restarted, "once");
    const file = await restarted.read({ path: "once.txt" }); assert.equal("content" in file ? file.content : null, once);
    await restarted.execute("once", { command: `printf '${once}' >> once.txt`, timeoutSeconds: 30 });
    const repeated = await restarted.read({ path: "once.txt" }); assert.equal("content" in repeated ? repeated.content : null, once);
    await foreign.requestCleanup();
    const workspace = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.conversationId, scope.conversationId) }); await reclaim(workspace.id);
    if (chatWorkspace) assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, chatWorkspace.id) })).state, "active");
  });
  await t.test("cancelling an actual model run cancels its remote job and deletes only its owned workspace", async () => {
    const forbidden = `FORBIDDEN-${randomUUID()}`;
    const { task, run, fence } = await createRun(`Use sandbox_exec to start command 'sleep 60; printf finished' with timeoutSeconds 90. Poll its job until it finishes, then add exactly one comment ${forbidden} to this assigned task. Do not add the comment before the command finishes.`);
    const controller = new AbortController();
    const running = executeTiTaskAttempt(db, executor, run.id, fence, binding, controller.signal).then(value => ({ value }), error => ({ error }));
    let workspace: any;
    for (let i = 0; i < 240; i++) {
      workspace = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.runId, run.id) });
      const operation = workspace && await db.query.tiSandboxOperations.findFirst({ where: and(eq(o.workspaceId, workspace.id), eq(o.state, "accepted")) });
      if (operation?.jobId) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(workspace?.sessionId);
    await createTiExecutionService(owner.context).invoke(db, "cancelRun", [run.id, { reason: "Actual-model acceptance cancellation" }]);
    controller.abort(); await running;
    await reclaim(workspace.id);
    assert.equal((await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) })).status, "cancelled");
    assert.equal((await owner.service.taskService.getTaskDetail(db, task.id)).comments.filter((comment: any) => comment.content.includes(forbidden)).length, 0);
    if (chatWorkspace) assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, chatWorkspace.id) })).state, "active");
  });
  if (chatSandbox && chatWorkspace) { await chatSandbox.requestCleanup(); await reclaim(chatWorkspace.id); }
  assert.equal((await cleanup.metrics()).filter((row: any) => row.count > 0).length, 0);
});
