import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mcpPool } from "../apps/api/src/mcp-pool";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, mcpServers, mcpTools, mcpToolCalls, mcpLocalRequests } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, registerMcpServerSchema, searchMcpToolsSchema } = apiRequire("@task-weaver/core");
const { eq } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("MCP authorization isolates discovery, local execution and live credentials", { skip: !databaseUrl, timeout: 150_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
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

  const remote = await owner.service.mcpRegistryService.registerServer(db, registerMcpServerSchema.parse({
    projectId: project.id, name: randomUUID(), transport: "streamable-http", config: { url: "https://example.test/mcp", headers: { authorization: "fixture-secret" } },
  }), owner.actor);
  const [tool] = await db.insert(mcpTools).values({ serverId: remote.id, name: "needle", description: "needle fixture" }).returning();
  const keyInput = { name: "Local host fixture", grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }], expiresAt: null };
  async function keyFixture() {
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, keyInput);
    const headers = new Headers({ authorization: `Bearer ${key.rawKey}` });
    const context = await runtime.verify(headers);
    return { key, headers, context, service: createResourceServices(context) };
  }
  const host = await keyFixture(), sibling = await keyFixture();
  const local = await host.service.mcpRegistryService.registerServer(db, registerMcpServerSchema.parse({
    personalOwnerId: owner.actor.id, personalOwnerType: "human", name: randomUUID(),
    transport: "stdio", config: { command: "fixture-never-run-on-api" }, clientId: "fixture-client", nodeId: "fixture-node",
    scope: "local", localScopeConsent: true, ttl: 3600,
  }), owner.actor);
  await host.service.mcpRegistryService.uploadTools(db, local.id, [{ name: "local-fixture", inputSchema: { type: "object" } }]);
  const localTool = (await db.select().from(mcpTools).where(eq(mcpTools.serverId, local.id)))[0];
  let connected = 0;
  const partitions: string[] = [];
  const pool = {
    getOrConnect: async (record: any) => {
      connected++; partitions.push(record.authorizationPartition);
      return { callTool: async () => ({ content: [{ type: "text", text: "private-result" }] }), listTools: async () => ({ tools: [] }) };
    }, disconnect: async () => {}, isConnected: () => false,
  };
  await t.test("scope predicates run before limits and redact credentials", async () => {
    assert.equal((await rest(`mcp/servers/${remote.id}`, admin.headers)).status, 404);
    assert.equal((await rest(`mcp/servers/${remote.id}`, outsider.headers)).status, 404);
    const read = await viewer.service.mcpRegistryService.getServer(db, remote.id);
    assert.ok(!JSON.stringify(read).includes("fixture-secret"));
    assert.ok(!JSON.stringify(read).includes("registeredCredentialId"));
    const result = await viewer.service.mcpRegistryService.searchTools(db, searchMcpToolsSchema.parse({ projectId: project.id, intent: "needle", limit: 1 }));
    assert.equal(result.length, 1); assert.equal(result[0].id, tool.id);
    await assert.rejects(viewer.service.mcpRegistryService.updateServer(db, remote.id, { active: false }, viewer.actor), AuthorizationError);
    await assert.rejects(owner.service.mcpRegistryService.callTool(db, tool.id, {}, owner.actor, pool), AuthorizationError);
    assert.equal(connected, 0);
    assert.equal((await caller(viewer.headers)).mcp !== undefined, true);
    await assert.rejects(owner.service.mcpRegistryService.updateServer(db, remote.id, { transport: "stdio", config: { command: "forged" } }, owner.actor));
    const legacy = await db.insert(mcpServers).values({ name: randomUUID(), projectId: project.id, transport: "sse", config: { url: "https://example.test" } }).returning();
    await assert.rejects(owner.service.mcpRegistryService.getServer(db, legacy[0].id), NotFoundError);
    assert.ok(!(await owner.service.mcpRegistryService.listServers(db, { projectId: project.id })).some((s: any) => s.id === legacy[0].id));
  });
  await t.test("remote calls recheck explicit invoke grants and partition credentials", async () => {
    await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member", explicitPermissions: ["mcp.invoke"] });
    for (let index = 0; index < 2; index++) {
      const key = await runtime.identity.issueKey(member.headers, member.actor.id, { name: "Remote invoke", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "mcp.invoke"] }], expiresAt: null });
      const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
      const service = createResourceServices(context);
      assert.ok((await service.mcpRegistryService.callTool(db, tool.id, { secret: "private-input" }, member.actor, pool)).content);
      await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member" });
      await assert.rejects(service.mcpRegistryService.callTool(db, tool.id, {}, member.actor, pool), AuthorizationError);
      await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member", explicitPermissions: ["mcp.invoke"] });
    }
    assert.notEqual(partitions[0], partitions[1]);
    assert.ok(partitions.every(Boolean));
    const audits = await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.serverId, remote.id));
    assert.equal(audits.length, 2);
    assert.ok(audits.every((row: any) => row.input === null && row.output === null));
    connected = 0;
  });
  await t.test("supplied client/node IDs cannot impersonate a registration", async () => {
    for (const identity of [outsider, admin, sibling]) {
      assert.equal((await rest(`mcp/servers/${local.id}/poll`, identity.headers, "POST", { clientId: "fixture-client", nodeId: "fixture-node" })).status, 404);
      await assert.rejects(identity.service.mcpRegistryService.getToolDetail(db, localTool.id), NotFoundError);
    }
    await assert.rejects(host.service.mcpRegistryService.syncTools(db, local.id, pool));
    assert.equal(connected, 0);
  });
  async function waitForLease() {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const response = await rest(`mcp/servers/${local.id}/poll`, host.headers, "POST", {});
      assert.equal(response.status, 200);
      if (response.body.items.length) return response.body.items[0];
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Local client did not receive its mailbox request");
  }
  await t.test("client mailbox completes once without starting an API process or retaining payloads", async () => {
    const invocation = host.service.mcpRegistryService.callTool(db, localTool.id, { private: "input" }, owner.actor, pool);
    const lease = await waitForLease();
    assert.equal(lease.arguments.private, "input");
    assert.equal((await rest(`mcp/requests/${lease.id}/result`, host.headers, "POST", { leaseToken: "0".repeat(64), result: {} })).status, 409);
    const output = { content: [{ type: "text", text: "private-result" }] };
    assert.equal((await rest(`mcp/requests/${lease.id}/result`, host.headers, "POST", { leaseToken: lease.leaseToken, result: output })).status, 200);
    assert.deepEqual(await invocation, output);
    assert.equal(connected, 0);
    assert.equal((await rest(`mcp/requests/${lease.id}/result`, host.headers, "POST", { leaseToken: lease.leaseToken, result: output })).status, 409);
    const stored = (await db.select().from(mcpLocalRequests).where(eq(mcpLocalRequests.id, lease.id)))[0];
    assert.equal(stored.arguments, null); assert.equal(stored.result, null); assert.deepEqual(stored.callerContext, {});
    const audits = await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.serverId, local.id));
    assert.equal(audits.length, 1); assert.equal(audits[0].input, null); assert.equal(audits[0].output, null);
  });
  await t.test("disabled servers and changed tool relationships reject leased results", async () => {
    const invocation = host.service.mcpRegistryService.callTool(db, localTool.id, {}, owner.actor, pool).then(() => null, (error: unknown) => error);
    const lease = await waitForLease();
    await db.update(mcpTools).set({ name: "changed" }).where(eq(mcpTools.id, localTool.id));
    assert.equal((await rest(`mcp/requests/${lease.id}/result`, host.headers, "POST", { leaseToken: lease.leaseToken, result: {} })).status, 404);
    await host.service.mcpRegistryService.updateServer(db, local.id, { active: false }, owner.actor);
    assert.ok(await invocation instanceof NotFoundError);
    assert.equal((await rest(`mcp/tools/${localTool.id}/call`, host.headers, "POST", {})).status, 404);
    await host.service.mcpRegistryService.updateServer(db, local.id, { active: true }, owner.actor);
    await db.update(mcpTools).set({ name: localTool.name }).where(eq(mcpTools.id, localTool.id));
  });
  await t.test("register-local executes stdio on the client without inheriting the TW key", async () => {
    await assert.rejects(mcpPool.getOrConnect({ id: local.id, name: "fixture", transport: "stdio", config: { command: "never-run" }, authorizationPartition: "fixture" }), /registered client/);
    const directory = await mkdtemp(join(tmpdir(), "tw-mcp-client-"));
    const fixture = join(directory, "server.cjs");
    await writeFile(fixture, `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "client-fixture", version: "1" } };
        if (request.method === "tools/list") result = { tools: [{ name: "local-fixture", inputSchema: { type: "object" } }] };
        if (request.method === "tools/call") result = { content: [{ type: "text", text: process.env.TW_API_KEY ? "credential-leaked" : "client-executed" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result ?? {} }) + "\\n");
      });
    `);
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const response = await api.request(req.url!, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number };
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "apps/cli/src/index.ts", "mcp", "register-local", "--server", local.id, "--command", process.execPath, "--args", JSON.stringify([fixture])], {
      env: { ...process.env, HOME: directory, TW_API_URL: `http://127.0.0.1:${address.port}`, TW_API_KEY: host.key.rawKey, TW_CLIENT_ID: "fixture-client", TW_NODE_ID: "fixture-node" },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let diagnostic = "";
    child.stdout.on("data", chunk => { diagnostic += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Client registration timed out: " + diagnostic)), 15_000);
      child.stdout.on("data", chunk => { output += chunk; if (output.includes("Starting heartbeat loop")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error("Client registration failed")); });
    });
    try {
      await ready;
      const result = await rest(`mcp/tools/${localTool.id}/call`, host.headers, "POST", {});
      assert.equal(result.status, 200);
      assert.equal(result.body.content[0].text, "client-executed");
      assert.equal(connected, 0);
    } finally {
      try { process.kill(-child.pid!, "SIGINT"); } catch {}
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  await t.test("credential revocation stops consumption and clears pending private data", async () => {
    const invocation = host.service.mcpRegistryService.callTool(db, localTool.id, {}, owner.actor, pool).then(() => null, (error: unknown) => error);
    const lease = await waitForLease();
    await runtime.identity.revokeKey(owner.headers, owner.actor.id, host.key.id);
    assert.equal((await rest(`mcp/requests/${lease.id}/result`, host.headers, "POST", { leaseToken: lease.leaseToken, result: {} })).status, 401);
    assert.ok(await invocation);
    const stored = (await db.select().from(mcpLocalRequests).where(eq(mcpLocalRequests.id, lease.id)))[0];
    assert.equal(stored.arguments, null); assert.equal(stored.leaseHash, null);
  });
});
