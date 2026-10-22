import { mcpServerReadTools } from "@task-weaver/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServerRoutes } from "./mcp-server";
import type { Env } from "../middleware/actor";
import { mcpServerCatalog, type VerifiedRequestContext } from "@task-weaver/contracts";

const id = "11111111-1111-4111-8111-111111111111";
function fixture(readOnly = false) {
  const tokens = new Map([["key-a", "actor-a"], ["key-b", "actor-b"]]);
  const calls: string[] = [];
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    const actorId = tokens.get((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (!actorId) return c.json({ error: "Authentication required" }, 401);
    // Test-only middleware models server verification. Production uses auth.verify.
    c.set("identity", { credential: { kind: "api_key" }, actor: { id: actorId, type: "human" } } as VerifiedRequestContext);
    await next();
  });
  app.route("/api/v1/mcp-server", createMcpServerRoutes({ allowedHosts: ["localhost"], readOnly,
    visibleTools: async () => mcpServerCatalog.map(tool => tool.name),
    executor: context => async (_name, args) => { calls.push(context.identity.actor.id); return { id: args.id, actor: context.identity.actor.id }; },
  }));
  const connect = async (token: string) => {
    const client = new Client({ name: "http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp-server"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    await client.connect(transport);
    return client;
  };
  return { app, tokens, calls, connect };
}

test("official HTTP SDK initializes, lists and isolates concurrent credentials", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.connect("key-a"), f.connect("key-b")]);
  try {
    assert.equal((await a.listTools()).tools.length, mcpServerCatalog.length);
    const results = await Promise.all([a.callTool({ name: "tw_tasks_get", arguments: { id } }), b.callTool({ name: "tw_tasks_get", arguments: { id } })]);
    assert.equal((results[0]!.structuredContent as { data: { actor: string } }).data.actor, "actor-a");
    assert.equal((results[1]!.structuredContent as { data: { actor: string } }).data.actor, "actor-b");
    f.tokens.delete("key-a");
    await assert.rejects(a.callTool({ name: "tw_tasks_get", arguments: { id } }));
    assert.equal(f.calls.length, 2);
  } finally { await a.close(); await b.close(); }
});

test("JSON adapter and HTTP transport apply read-only and strict arguments", async () => {
  const f = fixture(true);
  const client = await f.connect("key-a");
  try {
    assert.equal((await client.listTools()).tools.length, mcpServerReadTools.length);
    const catalog = await f.app.request("/api/v1/mcp-server/catalog", { headers: { authorization: "Bearer key-a" } });
    assert.deepEqual((await catalog.json() as { tools: string[] }).tools.sort(), [...mcpServerReadTools].sort());
    const write = await client.callTool({ name: "tw_tasks_status", arguments: { id, status: "done" } });
    assert.equal(write.isError, true);
    const spoof = await f.app.request("/api/v1/mcp-server/tools/tw_tasks_get", { method: "POST", headers: { authorization: "Bearer key-a", "content-type": "application/json" }, body: JSON.stringify({ id, actorId: "actor-b" }) });
    assert.equal(spoof.status, 400);
    assert.equal(f.calls.length, 0);
  } finally { await client.close(); }
});

test("MCP rejects missing credentials, untrusted hosts and oversized input before execution", async () => {
  const f = fixture();
  assert.equal((await f.app.request("/api/v1/mcp-server", { method: "POST" })).status, 401);
  const host = await f.app.request("http://untrusted.test/api/v1/mcp-server", { method: "POST", headers: { authorization: "Bearer key-a" } });
  assert.equal(host.status, 403);
  const large = await f.app.request("/api/v1/mcp-server/tools/tw_task_comments_add", { method: "POST", headers: { authorization: "Bearer key-a", "content-type": "application/json" }, body: JSON.stringify({ id, content: "x".repeat(1_048_576) }) });
  assert.equal(large.status, 413);
  const unsupported = await f.app.request("/api/v1/mcp-server", { headers: { authorization: "Bearer key-a", accept: "text/event-stream" } });
  assert.equal(unsupported.status, 405);
  const recursive = await f.app.request("/api/v1/mcp-server", { method: "POST", headers: { authorization: "Bearer key-a", "x-task-weaver-mcp-hop": "1" } });
  assert.equal(recursive.status, 400);
  assert.equal(f.calls.length, 0);
});
