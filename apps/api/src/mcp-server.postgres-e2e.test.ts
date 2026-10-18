import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb, runMigrations } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { createApiApplication } from "./application";

const databaseUrl = process.env.TW_MCP_E2E_DATABASE_URL;
test("MCP transports use live scoped authority and preserve collaboration guards", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_mcp_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const issue = (who: typeof f.owner, permissions: Array<"resource.read" | "resource.write">) => f.identity.issueKey(who.headers, who.context.actor.id, { name: "MCP fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions }] });
  const key = await issue(f.owner, ["resource.read", "resource.write"]);
  const readKey = await issue(f.owner, ["resource.read"]);
  const outsiderKey = await f.identity.issueKey(f.outsider.headers, f.outsider.context.actor.id, { name: "Outsider fixture", expiresAt: null, grants: [{ scope: "personal", actorId: f.outsider.context.actor.id, permissions: ["resource.read", "resource.write"] }] });
  const headers = (rawKey = key.rawKey) => ({ authorization: `Bearer ${rawKey}`, "content-type": "application/json" });
  const call = async (name: string, args: unknown, rawKey = key.rawKey) => {
    const response = await f.app.request(`http://127.0.0.1:3001/api/v1/mcp-server/tools/${name}`, { method: "POST", headers: headers(rawKey), body: JSON.stringify(args) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { structuredContent: { ok: boolean; data: any; error?: { code: string } } };
    return result.structuredContent;
  };
  const success = async (name: string, args: unknown) => { const result = await call(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  assert.ok((await success("tw_projects_list", {})).items.some((p: { id: string }) => p.id === f.project.id));
  const requirement = await success("tw_requirements_create", { projectId: f.project.id, title: "MCP requirement", status: "approved" });
  const task = await success("tw_tasks_create", { projectId: f.project.id, requirementId: requirement.id, title: "MCP task" });
  assert.equal((await success("tw_requirements_get", { id: requirement.id })).tasks, undefined);
  assert.equal((await success("tw_tasks_get", { id: task.id })).comments, undefined);
  assert.equal((await success("tw_tasks_list", { projectId: f.project.id })).meta.total, 1);
  await success("tw_tasks_claim", { id: task.id });
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Competing MCP participant" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "member", explicitPermissions: [] });
  const agentKey = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Competing MCP key", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write"] }] });
  assert.equal((await call("tw_tasks_claim", { id: task.id }, agentKey.rawKey)).error?.code, "claim_conflict");
  await success("tw_tasks_heartbeat", { id: task.id, extendMinutes: 10 });
  await success("tw_task_comments_add", { id: task.id, content: "MCP progress" });
  const comments = await success("tw_task_comments_list", { id: task.id, pageSize: 1 });
  assert.equal(comments.meta.total, 1); assert.equal(comments.items[0].authorId, f.owner.context.actor.id);
  await success("tw_tasks_release", { id: task.id, reason: "Fixture handoff" });
  const update = await success("tw_tasks_update", { id: task.id, patch: { title: "Updated task", expectedVersion: task.version } });
  assert.ok(update.version > task.version);
  assert.equal((await call("tw_tasks_update", { id: task.id, patch: { title: "Stale", expectedVersion: task.version } })).error?.code, "version_conflict");
  assert.equal((await call("tw_tasks_get", { id: task.id }, outsiderKey.rawKey)).ok, false);
  assert.equal((await call("tw_task_comments_add", { id: task.id, content: "Denied" }, readKey.rawKey)).ok, false);
  const blocker = await success("tw_tasks_create", { projectId: f.project.id, requirementId: requirement.id, title: "Blocker" });
  const dep = await success("tw_task_dependencies_add", { id: task.id, dependsOnTaskId: blocker.id });
  assert.equal((await success("tw_task_dependencies_list", { id: task.id })).meta.total, 1);
  assert.equal((await call("tw_tasks_status", { id: task.id, status: "done" })).error?.code, "dependency_conflict");
  await success("tw_task_dependencies_remove", { id: task.id, dependencyId: dep.id });
  const upstream = await success("tw_requirements_create", { projectId: f.project.id, title: "Upstream" });
  const reqDep = await success("tw_requirement_dependencies_add", { id: requirement.id, dependsOnRequirementId: upstream.id });
  assert.equal((await success("tw_requirement_dependencies_list", { id: requirement.id })).meta.total, 1);
  await success("tw_requirement_dependencies_remove", { id: requirement.id, dependencyId: reqDep.id });
  const doc = await success("tw_documents_create", { projectId: f.project.id, title: "MCP knowledge", content: "MCP context" });
  await success("tw_documents_update", { id: doc.id, patch: { content: "Updated MCP context", expectedVersion: doc.version } });
  await success("tw_document_task_links_add", { id: doc.id, taskId: task.id });
  await success("tw_document_requirement_links_add", { id: requirement.id, documentId: doc.id });
  assert.equal((await success("tw_documents_get", { id: doc.id })).content, "Updated MCP context");
  assert.equal((await success("tw_documents_list", { projectId: f.project.id, includeGlobal: false })).meta.total, 1);
  assert.equal((await success("tw_search", { query: "MCP", projectId: f.project.id, limit: 2 })).items.length, 2);
  assert.equal((await call("tw_search", { query: "MCP", projectId: f.project.id }, outsiderKey.rawKey)).ok, false);
  assert.equal((await call("tw_document_task_links_add", { id: doc.id, taskId: task.id }, outsiderKey.rawKey)).ok, false);
  assert.equal((await call("tw_task_dependencies_remove", { id: blocker.id, dependencyId: "11111111-1111-4111-8111-111111111111" })).ok, false);
  const personalTask = await call("tw_tasks_create", { scope: "personal", title: "Private MCP task" }, outsiderKey.rawKey);
  assert.equal(personalTask.ok, true);
  assert.equal((await call("tw_tasks_get", { id: personalTask.data.id })).ok, false);
  const personalDoc = await call("tw_documents_create", { scope: "personal", title: "Private MCP document", content: "Private context" }, outsiderKey.rawKey);
  assert.equal(personalDoc.ok, true);
  assert.equal((await call("tw_documents_get", { id: personalDoc.data.id })).ok, false);
  const cancelled = await success("tw_tasks_create", { projectId: f.project.id, requirementId: requirement.id, title: "Cancelled fixture" });
  await success("tw_tasks_status", { id: cancelled.id, status: "cancelled" });
  assert.equal((await call("tw_tasks_status", { id: cancelled.id, status: "todo" })).ok, false);
  const missing = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server", { method: "POST", headers: { "x-actor-id": f.owner.context.actor.id, "x-actor-type": "human" } });
  assert.equal(missing.status, 401);
  const origin = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server", { method: "POST", headers: { ...headers(), origin: "https://untrusted.test" } });
  assert.equal(origin.status, 403);
  const forged = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_tasks_get", { method: "POST", headers: { ...headers(outsiderKey.rawKey), "x-actor-id": f.owner.context.actor.id }, body: JSON.stringify({ id: task.id }) });
  assert.equal((await forged.json() as any).structuredContent.ok, false);

  let networkApp = f.app;
  const http = serve({ fetch: req => networkApp.fetch(req), hostname: "127.0.0.1", port: 0 });
  await once(http, "listening");
  const host = `127.0.0.1:${(http.address() as { port: number }).port}`;
  networkApp = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0], TW_MCP_ALLOWED_HOSTS: host, TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  t.after(async () => { if ("closeAllConnections" in http) http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const remote = new Client({ name: "real-http-sdk", version: "1.31.0" });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`http://${host}/api/v1/mcp-server`), { requestInit: { headers: headers() } }));
  t.after(() => remote.close());
  assert.equal((await remote.listTools()).tools.length, 29);
  assert.equal((await remote.callTool({ name: "tw_tasks_get", arguments: { id: task.id } })).isError, undefined);
  const directory = await mkdtemp(join(tmpdir(), "tw-mcp-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = new Client({ name: "real-stdio-sdk", version: "1.31.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve", "--read-only"], env: { ...env, TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: key.rawKey }, stderr: "pipe" });
  await local.connect(transport); t.after(() => local.close());
  assert.equal((await local.listTools()).tools.length, 12);
  assert.equal((await local.callTool({ name: "tw_tasks_get", arguments: { id: task.id } })).isError, undefined);
  assert.equal((await local.callTool({ name: "tw_tasks_status", arguments: { id: task.id, status: "done" } })).isError, true);
  if (process.env.TW_MCP_INSPECTOR_BIN) {
    const configPath = join(directory, "inspector.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: {
      remote: { type: "streamable-http", url: `http://${host}/api/v1/mcp-server`, headers: { Authorization: `Bearer ${key.rawKey}` } },
      local: { type: "stdio", command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve"], env: { TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: key.rawKey } },
    } }), { mode: 0o600 });
    const inspector = async (server: string, method: string, name?: string, args?: unknown) => {
      let stdout: string;
      try {
        const result = await promisify(execFile)(process.execPath, [process.env.TW_MCP_INSPECTOR_BIN!, "--cli", "--quiet", "--config", configPath, "--server", server, "--method", method, ...(name ? ["--tool-name", name, "--tool-args-json", JSON.stringify(args)] : [])], { timeout: 20_000, maxBuffer: 2_097_152, env: { ...env, MCP_CLIENT_CONFIG_PATH: join(directory, "inspector-client.json") } });
        stdout = result.stdout;
      } catch (error) {
        const failure = error as { stderr?: string };
        throw new Error(`Inspector acceptance failed: ${(failure.stderr ?? "process failed").replaceAll(key.rawKey, "[redacted]")}`);
      }
      return JSON.parse(stdout);
    };
    for (const transportName of ["remote", "local"]) {
      const initialization = await inspector(transportName, "initialize");
      assert.equal(initialization.protocolVersion, "2025-11-25");
      const tools = await inspector(transportName, "tools/list");
      assert.equal(tools.tools.length, 29);
      const invoke = async (name: string, args: unknown) => {
        const result = await inspector(transportName, "tools/call", name, args);
        assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
        return result.structuredContent.data;
      };
      await invoke("tw_projects_get", { id: f.project.id });
      await invoke("tw_search", { projectId: f.project.id, query: "MCP" });
      const req = await invoke("tw_requirements_create", { projectId: f.project.id, title: `Inspector ${transportName}`, status: "approved" });
      const item = await invoke("tw_tasks_create", { projectId: f.project.id, requirementId: req.id, title: "Inspector collaboration" });
      await invoke("tw_tasks_claim", { id: item.id });
      await invoke("tw_task_comments_add", { id: item.id, content: "Inspector progress evidence" });
      await invoke("tw_tasks_status", { id: item.id, status: "in_progress" });
      await invoke("tw_tasks_release", { id: item.id });
      const visible = await f.app.request(`/api/v1/tasks/${item.id}`, { headers: f.owner.headers });
      assert.equal(visible.status, 200);
      const record = await visible.json() as { status: string; comments: unknown[] };
      assert.equal(record.status, "in_progress"); assert.equal(record.comments.length, 1);
    }
    t.diagnostic("MCP Inspector 2.11.0 completed local and remote collaboration workflows.");
  }
  await f.identity.revokeKey(f.owner.headers, f.owner.context.actor.id, key.id);
  await assert.rejects(remote.callTool({ name: "tw_tasks_get", arguments: { id: task.id } }));
  const revokedLocal = await local.callTool({ name: "tw_tasks_get", arguments: { id: task.id } });
  assert.equal(revokedLocal.isError, true);
  assert.equal((revokedLocal.structuredContent as { error: { code: string } }).error.code, "unauthenticated");
});
