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
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, apiKeys, mcpInvocationApprovals, projectMemberships, mcpInvocationAudits } from "@task-weaver/db";
import { cleanupMcpInvocationHistory, setMcpInvocationPolicy, approveMcpInvocation, listMcpInvocationAudits, createResourceServices, skillPackageStorageService, registerSkillPackageSchema } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { createApiApplication } from "./application";

const databaseUrl = process.env.TW_MCP_E2E_DATABASE_URL;
test("MCP transports use live scoped authority and preserve collaboration guards", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_mcp_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const packageDirectory = await mkdtemp(join(tmpdir(), "tw-mcp-packages-"));
  const previousStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
  process.env.SKILL_PACKAGE_STORAGE_DIR = packageDirectory;
  t.after(async () => { if (previousStorage === undefined) delete process.env.SKILL_PACKAGE_STORAGE_DIR; else process.env.SKILL_PACKAGE_STORAGE_DIR = previousStorage; await rm(packageDirectory, { recursive: true, force: true }); });
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const issue = (who: typeof f.owner, permissions: Array<"resource.read" | "resource.write">) => f.identity.issueKey(who.headers, who.context.actor.id, { name: "MCP fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions }] });
  const key = await issue(f.owner, ["resource.read", "resource.write"]);
  const readKey = await issue(f.owner, ["resource.read"]);
  const expiredKey = await issue(f.owner, ["resource.read"]);
  await db.update(apiKeys).set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, expiredKey.id));
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
  const defaultHostApp = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0], TW_MCP_ALLOWED_HOSTS: " ", TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  const defaultHostRead = await defaultHostApp.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_projects_get", { method: "POST", headers: headers(), body: JSON.stringify({ id: f.project.id }) });
  assert.equal(defaultHostRead.status, 200);
  assert.equal((await defaultHostRead.json() as any).structuredContent.ok, true);
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
  const expired = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_tasks_get", { method: "POST", headers: headers(expiredKey.rawKey), body: JSON.stringify({ id: task.id }) });
  assert.equal(expired.status, 401);
  const isolated = await Promise.all([call("tw_tasks_get", { id: task.id }), call("tw_tasks_get", { id: personalTask.data.id }, outsiderKey.rawKey)]);
  assert.equal(isolated[0]!.data.id, task.id); assert.equal(isolated[1]!.data.id, personalTask.data.id);
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
  assert.equal((await remote.listTools()).tools.length, 43);
  assert.equal((await remote.callTool({ name: "tw_tasks_get", arguments: { id: task.id } })).isError, undefined);
  const directory = await mkdtemp(join(tmpdir(), "tw-mcp-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = new Client({ name: "real-stdio-sdk", version: "1.31.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve", "--read-only"], env: { ...env, TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: key.rawKey }, stderr: "pipe" });
  await local.connect(transport); t.after(() => local.close());
  assert.equal((await local.listTools()).tools.length, 23);
  assert.equal((await local.callTool({ name: "tw_tasks_get", arguments: { id: task.id } })).isError, undefined);
  assert.equal((await local.callTool({ name: "tw_tasks_status", arguments: { id: task.id, status: "done" } })).isError, true);
  // 0.3.11 planning and context use the same authenticated executor on both transports.
  const skill = await success("tw_documents_create", { projectId: f.project.id, title: "MCP planning guidance", content: "Use ordered slices and preserve claims.", docType: "skill" });
  assert.equal((await success("tw_context_get", { id: skill.id })).content, "Use ordered slices and preserve claims.");
  assert((await success("tw_context_search", { projectId: f.project.id, intent: "planning" })).items.some((row: any) => row.id === skill.id));
  assert.equal((await call("tw_context_get", { id: skill.id }, outsiderKey.rawKey)).ok, false);
  assert.equal((await call("tw_context_get", { id: doc.id })).ok, false);
  const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: "MCP package", files: [{ path: "SKILL.md", contentBase64: Buffer.from("# MCP guidance").toString("base64") }, { path: "reference.md", contentBase64: Buffer.from("Reference").toString("base64") }, { path: "large.md", contentBase64: Buffer.from("x".repeat(32769)).toString("base64") }] }), { id: f.owner.context.actor.id, type: "human" }, new skillPackageStorageService.LocalSkillPackageStorageAdapter(packageDirectory));
  const metadata = await success("tw_skill_packages_get", { packageId: pkg.id });
  assert.equal(JSON.stringify(metadata).includes(packageDirectory), false);
  assert.equal(metadata.version.storageKeyPrefix, undefined);
  assert.equal((await success("tw_skill_packages_list", { projectId: f.project.id })).items.length, 1);
  const files = await success("tw_skill_package_files", { packageId: pkg.id, limit: 1 });
  assert.equal(files.items.length, 1); assert.equal(files.meta.nextOffset, 1);
  assert.equal((await success("tw_skill_package_read", { packageId: pkg.id, path: "reference.md" })).content, "Reference");
  assert.equal((await call("tw_skill_package_read", { packageId: pkg.id, path: "large.md" })).error?.code, "result_too_large");
  assert.equal((await call("tw_skill_packages_get", { packageId: pkg.id }, outsiderKey.rawKey)).ok, false);
  const plan = { projectId: f.project.id, documents: [{ key: "design", title: "Planning design", content: "Stage plan" }], requirements: [{ key: "planned", title: "Planned MCP requirement", status: "approved", documents: ["design"], slices: [{ key: "one", title: "First" }, { key: "two", title: "Second" }, { key: "three", title: "Third" }], tasks: [{ key: "first", title: "First task", slice: "one" }, { key: "second", title: "Second task", slice: "two", dependsOn: ["first"] }, { key: "third", title: "Third task", slice: "three", dependsOn: ["second"] }] }] };
  const preview = await success("tw_plan_validate", { plan });
  assert.equal(preview.dryRun, true); assert.equal(preview.refs.requirements[0].id, null);
  assert.equal((await call("tw_plan_validate", { plan }, readKey.rawKey)).ok, false);
  const idempotencyKey = randomUUID();
  const [firstApply, concurrentApply] = await Promise.all([success("tw_plan_apply", { plan, idempotencyKey }), success("tw_plan_apply", { plan, idempotencyKey })]);
  assert.deepEqual(firstApply.refs, concurrentApply.refs); assert.notEqual(firstApply.replayed, concurrentApply.replayed);
  assert.equal((await success("tw_plan_apply", { plan, idempotencyKey })).replayed, true);
  assert.equal((await call("tw_plan_apply", { plan: { ...plan, documents: [{ key: "design", title: "Changed", content: "Changed" }] }, idempotencyKey })).error?.code, "conflict");
  const plannedRequirement = firstApply.refs.requirements[0].id;
  const slices = await success("tw_execution_slices_list", { id: plannedRequirement, pageSize: 2 });
  assert.equal(slices.items.length, 2); assert.equal(slices.meta.nextPage, 2);
  const firstSlice = slices.items[0];
  const changedSlice = await success("tw_execution_slices_update", { id: firstSlice.id, expectedUpdatedAt: firstSlice.updatedAt, patch: { resultSummary: "First handoff" } });
  assert.notEqual(changedSlice.updatedAt, firstSlice.updatedAt);
  assert.equal((await call("tw_execution_slices_update", { id: firstSlice.id, expectedUpdatedAt: firstSlice.updatedAt, patch: { resultSummary: "Stale" } })).error?.code, "version_conflict");
  assert.equal((await call("tw_execution_slices_create", { id: plannedRequirement, input: { title: "Foreign task", taskIds: [task.id] } })).ok, false);
  const sliceServices = createResourceServices(f.owner.context);
  await sliceServices.claimService.claimRequirement(db, plannedRequirement, { id: f.owner.context.actor.id, type: "human" }, 5);
  assert.equal((await call("tw_execution_slices_create", { id: plannedRequirement, input: { title: "Wrong lease holder" } }, agentKey.rawKey)).ok, false);
  await sliceServices.claimService.releaseRequirement(db, plannedRequirement, { id: f.owner.context.actor.id, type: "human" });
  assert.equal((await call("tw_tasks_status", { id: firstApply.refs.tasks[1].id, status: "in_progress" })).ok, false);
  const context = await success("tw_requirements_context", { id: plannedRequirement, sections: ["tasks", "slices", "documents", "dependencies"], limit: 1, maxBytes: 2048 });
  assert(Buffer.byteLength(JSON.stringify(context), "utf8") <= 2048);
  assert(context.meta.truncatedSections.length + context.meta.omittedSections.length > 0);
  assert.equal(context.meta.consistency, "read_committed_not_snapshot");
  assert.equal((await call("tw_requirements_context", { id: plannedRequirement }, outsiderKey.rawKey)).ok, false);
  assert.equal((await call("tw_requirements_context", { id: plannedRequirement, sections: ["activity"] }, readKey.rawKey)).ok, false);
  const plannedTask = firstApply.refs.tasks[0].id;
  assert.equal((await local.callTool({ name: "tw_tasks_context", arguments: { id: plannedTask } })).isError, undefined);
  assert.equal((await local.callTool({ name: "tw_plan_apply", arguments: { plan, idempotencyKey } })).isError, true);
  const remoteContext = await remote.callTool({ name: "tw_requirements_context", arguments: { id: plannedRequirement } });
  assert.equal(remoteContext.isError, undefined);
  const invalid = { projectId: f.project.id, requirements: [{ key: "invalid", title: "Rollback plan", slices: [{ key: "bad-slice", title: "Bad" }], tasks: [{ key: "bad-task", title: "Bad", slice: "missing-slice" }] }] };
  assert.equal((await call("tw_plan_apply", { plan: invalid, idempotencyKey: randomUUID() })).ok, false);
  const afterInvalid = await success("tw_requirements_list", { projectId: f.project.id, query: "Rollback plan" });
  assert.equal(afterInvalid.meta.total, 0);
  const depsPage1 = await success("tw_requirements_context", { id: plannedRequirement, sections: ["tasks"], limit: 1 });
  const depsPage2 = await success("tw_requirements_context", { id: plannedRequirement, sections: ["tasks"], limit: 1, offset: depsPage1.sections.tasks.nextOffset });
  assert.notEqual(depsPage1.sections.tasks.items[0].id, depsPage2.sections.tasks.items[0].id);
  const cancelledPlanParent = await success("tw_requirements_create", { projectId: f.project.id, title: "Terminal planning parent" });
  await success("tw_requirements_update", { id: cancelledPlanParent.id, patch: { status: "cancelled" } });
  const lateFailure = { projectId: f.project.id, documents: [{ key: "rollback-document", title: "Must roll back document", content: "Rollback" }], requirements: [{ key: "terminal-parent", existingId: cancelledPlanParent.id, tasks: [{ key: "late-task", title: "Must fail after document creation" }] }] };
  assert.equal((await call("tw_plan_apply", { plan: lateFailure, idempotencyKey: randomUUID() })).ok, false);
  assert.equal((await success("tw_documents_list", { projectId: f.project.id, query: "Must roll back document" })).meta.total, 0);
  const forbiddenReference = { projectId: f.project.id, documents: [{ key: "private", existingId: personalDoc.data.id }] };
  assert.equal((await call("tw_plan_validate", { plan: forbiddenReference })).ok, false);
  const writeLocal = new Client({ name: "real-stdio-planning", version: "1" });
  await writeLocal.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve"], env: { ...env, TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: key.rawKey }, stderr: "pipe" }));
  t.after(() => writeLocal.close());
  for (const [transportName, client] of [["HTTP", remote], ["stdio", writeLocal]] as const) {
    const input = { projectId: f.project.id, requirements: [{ key: "transport", title: `${transportName} planning`, status: "approved", slices: [{ key: "start", title: "Start" }, { key: "finish", title: "Finish" }], tasks: [{ key: "transport-task", title: "Transport task", slice: "start" }] }] };
    const invoke = async (name: string, arguments_: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: arguments_ }); assert.notEqual(result.isError, true, JSON.stringify(result)); return (result.structuredContent as any).data; };
    assert.equal((await invoke("tw_context_search", { projectId: f.project.id, intent: "planning" })).items.length > 0, true);
    assert.equal((await invoke("tw_plan_validate", { plan: input })).dryRun, true);
    const applied = await invoke("tw_plan_apply", { plan: input, idempotencyKey: randomUUID() });
    const createdSlice = await invoke("tw_execution_slices_create", { id: applied.refs.requirements[0].id, input: { title: "Additional stage" } });
    assert(createdSlice.id);
    const stage = (await invoke("tw_execution_slices_list", { id: applied.refs.requirements[0].id })).items[0];
    assert.equal((await invoke("tw_execution_slices_update", { id: stage.id, expectedUpdatedAt: stage.updatedAt, patch: { resultSummary: "Transport handoff" } })).resultSummary, "Transport handoff");
    assert.equal((await invoke("tw_tasks_context", { id: applied.refs.tasks[0].id })).entity.id, applied.refs.tasks[0].id);
  }
  const directoryKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Directory-only fixture", expiresAt: null, grants: [{ scope: "global", permissions: ["project.discover"] }] });
  const directoryResponse = await f.app.request("/api/v1/projects/discover?pageSize=1", { headers: headers(directoryKey.rawKey) });
  assert.equal(directoryResponse.status, 200);
  const directoryResult = await directoryResponse.json() as any;
  assert.equal(directoryResult.items.length, 1);
  assert.deepEqual(Object.keys(directoryResult.items[0]).sort(), ["id", "name", "status"]);
  assert.equal((await f.app.request(`/api/v1/projects/${f.project.id}`, { headers: headers(directoryKey.rawKey) })).status, 404);
  const directoryRemote = new Client({ name: "directory-http", version: "1" });
  const directoryLocal = new Client({ name: "directory-stdio", version: "1" });
  try {
    await directoryRemote.connect(new StreamableHTTPClientTransport(new URL(`http://${host}/api/v1/mcp-server`), { requestInit: { headers: headers(directoryKey.rawKey) } }));
    await directoryLocal.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve"], env: { ...env, TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: directoryKey.rawKey }, stderr: "pipe" }));
    for (const client of [directoryRemote, directoryLocal]) {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["tw_projects_discover"]);
      const result = await client.callTool({ name: "tw_projects_discover", arguments: { pageSize: 1 } });
      assert.equal((result.structuredContent as any).ok, true);
      assert.equal((await client.callTool({ name: "tw_projects_get", arguments: { id: f.project.id } })).isError, true);
    }
  } finally { await directoryRemote.close(); await directoryLocal.close(); }
  // Dynamic discovery and exact-operation approvals are identical on real transports.
  const scope = { projectId: f.project.id };
  await setMcpInvocationPolicy(db, f.owner.context, scope, "tw_task_comments_add", "approval");
  for (const client of [remote, writeLocal]) {
    const args = { id: task.id, content: "Sensitive marker must not enter audit" };
    const pending = await client.callTool({ name: "tw_task_comments_add", arguments: args });
    const approvalId = (pending.structuredContent as any).error.approvalId;
    assert.equal((pending.structuredContent as any).error.code, "approval_required");
    await approveMcpInvocation(db, f.owner.context, approvalId);
    const changed = await client.callTool({ name: "tw_task_comments_add", arguments: { ...args, content: "Changed", approvalId } });
    assert.equal((changed.structuredContent as any).error.code, "forbidden");
    const approved = await client.callTool({ name: "tw_task_comments_add", arguments: { ...args, approvalId } });
    assert.notEqual(approved.isError, true, JSON.stringify(approved));
    assert.equal((await client.callTool({ name: "tw_task_comments_add", arguments: { ...args, approvalId } })).isError, true);
  }
  for (const invalidation of ["expiry", "policy", "resource", "grant", "membership"]) {
    const args = { id: task.id, content: "Invalidated approval" };
    const pending = await call("tw_task_comments_add", args);
    const approvalId = (pending.error as any).approvalId;
    await approveMcpInvocation(db, f.owner.context, approvalId);
    if (invalidation === "expiry") await db.update(mcpInvocationApprovals).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(mcpInvocationApprovals.id, approvalId));
    if (invalidation === "policy") await setMcpInvocationPolicy(db, f.owner.context, scope, "tw_task_comments_add", "approval");
    if (invalidation === "resource") await success("tw_tasks_update", { id: task.id, patch: { title: "Changed after approval" } });
    if (invalidation === "membership") await db.update(projectMemberships).set({ updatedAt: new Date() }).where(eq(projectMemberships.actorId, f.owner.context.actor.id));
    if (invalidation === "grant") {
      const [current] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
      await db.update(apiKeys).set({ grantVersion: current!.grantVersion + 1 }).where(eq(apiKeys.id, key.id));
    }
    assert.equal((await call("tw_task_comments_add", { ...args, approvalId })).ok, false, invalidation);
  }
  await setMcpInvocationPolicy(db, f.owner.context, scope, "tw_task_comments_add", "deny");
  for (const client of [remote, writeLocal]) {
    assert.equal((await client.listTools()).tools.some(tool => tool.name === "tw_task_comments_add"), false);
    assert.equal((await client.callTool({ name: "tw_task_comments_add", arguments: { id: task.id, content: "Cached discovery attack" } })).isError, true);
  }
  const audit = await listMcpInvocationAudits(db, f.owner.context, scope, 100);
  assert(audit.some(row => row.errorCode === "approval_required"));
  assert(audit.some(row => row.outcome === "success"));
  assert.equal(JSON.stringify(audit).includes("Sensitive marker"), false);
  assert.equal(JSON.stringify(audit).includes(key.rawKey), false);
  await assert.rejects(listMcpInvocationAudits(db, f.outsider.context, scope));
  const oldAudit = { actorId: f.owner.context.actor.id, credentialId: key.id, serverId: "task-weaver", toolId: "tw_tasks_get", outcome: "success", durationMs: 1, createdAt: new Date(Date.now() - 31 * 86_400_000) };
  const [expiredProjectAudit, isolatedPersonalAudit] = await db.insert(mcpInvocationAudits).values([
    { ...oldAudit, scopeKey: "project:" + f.project.id },
    { ...oldAudit, scopeKey: "personal:" + f.outsider.context.actor.id },
  ]).returning();
  await cleanupMcpInvocationHistory(db, f.owner.context, scope);
  assert.equal((await db.select().from(mcpInvocationAudits).where(eq(mcpInvocationAudits.id, expiredProjectAudit!.id))).length, 0);
  assert.equal((await db.select().from(mcpInvocationAudits).where(eq(mcpInvocationAudits.id, isolatedPersonalAudit!.id))).length, 1);
  await setMcpInvocationPolicy(db, f.owner.context, scope, "tw_task_comments_add", "allow");
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
      assert.equal(tools.tools.length, 43);
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
      const cli = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "task", "get", item.id, "--json"], { timeout: 15_000, env: { ...env, TW_CONFIG_DIR: directory, TW_API_URL: `http://${host}`, TW_API_KEY: key.rawKey } });
      const cliRecord = JSON.parse(cli.stdout);
      assert.equal(cliRecord.status, "in_progress"); assert.equal(cliRecord.comments.length, 1);
    }
    t.diagnostic("MCP Inspector 2.11.0 completed local and remote collaboration workflows.");
  }
  await f.identity.revokeKey(f.owner.headers, f.owner.context.actor.id, key.id);
  await assert.rejects(remote.listTools());
  await assert.rejects(local.listTools());
  await assert.rejects(remote.callTool({ name: "tw_tasks_get", arguments: { id: task.id } }));
  const revokedLocal = await local.callTool({ name: "tw_tasks_get", arguments: { id: task.id } });
  assert.equal(revokedLocal.isError, true);
  assert.equal((revokedLocal.structuredContent as { error: { code: string } }).error.code, "unauthenticated");
});
