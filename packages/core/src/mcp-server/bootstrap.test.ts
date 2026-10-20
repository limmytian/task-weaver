import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_LIMITS, mcpServerCatalog } from "@task-weaver/contracts";
import { buildCapabilityBootstrap } from "./bootstrap";

test("bootstrap filters denied tools and cannot advertise hosted runtimes as ready", () => {
  const allowed = mcpServerCatalog.map(tool => tool.name);
  const result = buildCapabilityBootstrap(allowed.filter(name => name !== "tw_context_get"));
  assert.equal(result.tools.includes("tw_context_get"), false);
  assert.equal(result.capabilities.skills.state, "unavailable");
  assert.deepEqual(result.capabilities.skillPackages, { state: "available", executionMode: "instructions" });
  assert.equal(result.capabilities.memories.state, "available");
  for (const name of ["externalTools", "hostedExecution", "plugins"] as const) {
    assert.equal(result.capabilities[name].state, "unavailable");
  }
  assert.ok(result.tools.every(name => !/_(create|update|apply|status|claim)$/.test(name)));
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
