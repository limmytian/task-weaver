import assert from "node:assert/strict";
import test from "node:test";

import {
  registerPiAgentGatewayRuntime,
} from "../pi-agent-gateway-worker";
import piAgentRoutes from "./pi-agent";

test("worker management routes report disabled runtime", async () => {
  registerPiAgentGatewayRuntime({ enabled: false, defaultTimeoutSeconds: 900 }, null);

  const statusResponse = await piAgentRoutes.request("/worker/status");
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    enabled: false,
    running: false,
    workerId: null,
    assignedAgentId: null,
    activeRunId: null,
    startedAt: null,
    lastPollAt: null,
    lastCompletedAt: null,
    lastError: null,
  });

  const healthResponse = await piAgentRoutes.request("/worker/health");
  assert.equal(healthResponse.status, 503);
  assert.deepEqual(await healthResponse.json(), {
    ok: false,
    enabled: false,
    error: "Partners Gateway is not configured",
  });
});

test("worker health route probes the configured gateway", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return new Response(JSON.stringify({ status: "ok", version: "1.2.3" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  registerPiAgentGatewayRuntime({
    enabled: true,
    baseUrl: "http://gateway.local",
    serviceToken: "secret-token",
    defaultTimeoutSeconds: 900,
  }, null);

  try {
    const response = await piAgentRoutes.request("/worker/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      enabled: true,
      gateway: { status: "ok", version: "1.2.3" },
    });
    assert.deepEqual(calls, [{
      url: "http://gateway.local/health",
      authorization: "Bearer secret-token",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
