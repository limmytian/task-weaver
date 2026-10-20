import assert from "node:assert/strict";
import test from "node:test";
import { createMcpInvocationBudget, McpInvocationBusy } from "./mcp-invocation-budget";

test("MCP permits limit actual per-actor dispatch while unrelated actors remain available", () => {
  const acquire = createMcpInvocationBudget();
  const releases = Array.from({ length: 4 }, () => acquire("actor", "server"));
  assert.throws(() => acquire("actor", "server"), McpInvocationBusy);
  const independent = acquire("other", "server"); independent();
  releases[0]!(); releases[0]!();
  const next = acquire("actor", "server"); next();
  releases.forEach(release => release());
});

test("MCP rate budget refills without replaying calls or retaining unbounded bucket state", () => {
  let time = 0;
  const acquire = createMcpInvocationBudget(() => time);
  for (let i = 0; i < 20; i++) acquire("actor", "server")();
  assert.throws(() => acquire("actor", "server"), McpInvocationBusy);
  time = 200; acquire("actor", "server")();
  assert.throws(() => acquire("actor", "server"), McpInvocationBusy);
  time = 100000;
  for (let i = 0; i < 1024; i++) acquire(`actor-${i}`, "server")();
  assert.throws(() => acquire("overflow", "server"), McpInvocationBusy);
  time += 60001; acquire("overflow", "server")();
});
