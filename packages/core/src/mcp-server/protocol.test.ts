import { mcpServerCatalog, mcpServerReadTools } from "@task-weaver/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpToolCaller, createTaskWeaverMcpServer } from "./index";

const id = "11111111-1111-4111-8111-111111111111";
test("official SDK negotiates, lists the shared catalog and calls validated tools", async () => {
  const calls: unknown[] = [];
  const server = createTaskWeaverMcpServer(createMcpToolCaller(async (name, args) => { calls.push([name, args]); return { id, title: "Authorized task" }; }));
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, mcpServerCatalog.length);
    const result = await client.callTool({ name: "tw_tasks_get", arguments: { id } });
    assert.deepEqual(result.structuredContent, { ok: true, data: { id, title: "Authorized task" } });
    await assert.rejects(client.callTool({ name: "tw_tasks_status", arguments: { id, status: "done", force: true } }), /Invalid tool arguments/);
    await assert.rejects(client.callTool({ name: "tw_tasks_get", arguments: { id, actorId: "forged" } }), /Invalid tool arguments/);
    await assert.rejects(client.callTool({ name: "request", arguments: {} }), /Unknown tool/);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test("read-only discovery and direct dispatch both prohibit writes", async () => {
  let executed = false;
  const call = createMcpToolCaller(async () => { executed = true; }, { readOnly: true });
  const server = createTaskWeaverMcpServer(call, { readOnly: true });
  const client = new Client({ name: "read-only-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const list = await client.listTools();
    assert.equal(list.tools.length, mcpServerReadTools.length);
    assert.ok(list.tools.every(tool => tool.annotations?.readOnlyHint));
    const result = await client.callTool({ name: "tw_tasks_status", arguments: { id, status: "done" } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "read_only");
    assert.equal(executed, false);
  } finally { await client.close(); await server.close(); }
});

test("timeouts retain concurrency permits until execution settles and never retry writes", async () => {
  const budget = { active: 0, pending: new Set<Promise<unknown>>() };
  const completions: Array<() => void> = [];
  let executions = 0;
  const call = createMcpToolCaller(async () => {
    executions++;
    await new Promise<void>(resolve => completions.push(resolve));
    return { id };
  }, { budget, timeoutMs: 10 });
  // A normal referenced timer keeps this test alive while runtime deadline timers are unref'ed.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => call("tw_tasks_status", { id, status: "done" })));
    assert.ok(results.every(result => (result.structuredContent as { error: { code: string } }).error.code === "timeout"));
    assert.equal(budget.active, 8);
    assert.equal(budget.pending.size, 8);
    assert.equal((await call("tw_tasks_get", { id })).isError, true);
    assert.equal(executions, 8);
    completions.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(budget.active, 0);
    assert.equal(budget.pending.size, 0);
  } finally { clearInterval(keepAlive); completions.forEach(resolve => resolve()); }
});

test("public errors redact internal failures and oversized results are not silently truncated", async () => {
  const failure = await createMcpToolCaller(async () => { throw new Error("Bearer private-credential database-host"); })("tw_tasks_get", { id });
  assert.equal(JSON.stringify(failure).includes("private-credential"), false);
  const large = await createMcpToolCaller(async () => "x".repeat(262_144))("tw_documents_get", { id });
  assert.equal((large.structuredContent as { error: { code: string } }).error.code, "result_too_large");
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await createMcpToolCaller(async () => { calls++; }, { signal: controller.signal })("tw_tasks_get", { id });
  assert.equal(calls, 0);
});

test("mid-call cancellation does not retry or free a still-running mutation", async () => {
  const controller = new AbortController();
  const budget = { active: 0, pending: new Set<Promise<unknown>>() };
  let finish: () => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const call = createMcpToolCaller(async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return { id }; }, { budget });
  const result = call("tw_tasks_status", { id, status: "done" }, controller.signal);
  await ready; controller.abort();
  assert.equal(((await result).structuredContent as { error: { code: string } }).error.code, "cancelled");
  assert.equal(budget.active, 1);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.active, 0);
    assert.equal(budget.pending.size, 0);
});
