import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_LIMITS, mcpServerCatalog } from "@task-weaver/contracts";
import { buildCapabilityBootstrap, readCapabilityBootstrap } from "./bootstrap";

test("bootstrap filters denied tools and cannot advertise hosted runtimes as ready", () => {
  const allowed = mcpServerCatalog.map(tool => tool.name);
  const result = buildCapabilityBootstrap(allowed.filter(name => name !== "tw_context_get"));
  assert.equal(result.tools.includes("tw_context_get"), false);
  assert.equal(result.capabilities.skills.state, "unavailable");
  assert.deepEqual(result.capabilities.skillPackages, { state: "available", executionMode: "instructions" });
  assert.equal(result.capabilities.memories.state, "available");
  for (const name of ["hostedExecution", "plugins"] as const) {
    assert.equal(result.capabilities[name].state, "unavailable");
  }
  assert.ok(result.tools.every(name => !/_(create|update|apply|status|claim)$/.test(name)));
});

test("runtime discovery failure preserves instruction access and does not advertise execution", async () => {
  const result = await readCapabilityBootstrap(mcpServerCatalog.map(tool => tool.name), "invalid-json");
  assert.equal(result.capabilities.skills.state, "available");
  assert.equal(result.capabilities.hostedExecution.state, "unavailable");
  assert.equal(result.execution, undefined);
});

test("ready execution adds bounded explicit workflow guidance only for eligible callers", () => {
  const allowed = mcpServerCatalog.map(tool => tool.name);
  const result = buildCapabilityBootstrap(allowed, { state: "available", executionMode: "isolated" });
  assert.equal(result.execution?.run, "tw_skills_run");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CAPABILITY_LIMITS.bootstrapBytes);
  assert.equal(buildCapabilityBootstrap(allowed.filter(name => name !== "tw_skills_run"), { state: "available", executionMode: "isolated" }).execution, undefined);
});

test("bootstrap stays small for large catalogs and never injects resource bodies or tool schemas", () => {
  for (const allowed of [[], mcpServerCatalog.map(tool => tool.name), Array.from({ length: 10000 }, (_, i) => `external_${i}`)]) {
    const result = buildCapabilityBootstrap(allowed);
    const text = JSON.stringify(result);
    assert.ok(Buffer.byteLength(text) <= CAPABILITY_LIMITS.bootstrapBytes);
    assert.ok(result.tools.length <= 12);
    assert.equal(text.includes("inputSchema"), false);
    assert.equal(result.loading.strategy, "on_demand");
  }
});
