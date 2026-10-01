import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@task-weaver/db";
import { composeTaskWeaverModules, ModuleCompositionError } from "@task-weaver/module-sdk";

import { createPartnersGatewayModule } from "./module";

function workerRoutes(env: NodeJS.ProcessEnv) {
  return createPartnersGatewayModule({} as Database, env).apiRoutes[0]!.route;
}

test("worker management routes report disabled runtime", async () => {
  const routes = workerRoutes({});

  const statusResponse = await routes.request("/status");
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

  const healthResponse = await routes.request("/health");
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
  const routes = workerRoutes({
    PARTNERS_GATEWAY_URL: "http://gateway.local",
    PARTNERS_GATEWAY_SERVICE_TOKEN: "secret-token",
  });

  try {
    const response = await routes.request("/health");
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

test("module configuration rejects incomplete Gateway credentials before startup", () => {
  const module = createPartnersGatewayModule({} as Database, {});
  assert.throws(() => composeTaskWeaverModules([module], {
    coreVersion: module.manifest.version,
    configuration: {
      [module.manifest.id]: {
        enabled: true,
        baseUrl: "https://gateway.example",
        defaultTimeoutSeconds: 900,
      },
    },
  }), (error: unknown) => {
    assert.ok(error instanceof ModuleCompositionError);
    assert.equal(error.code, "configuration_invalid");
    return true;
  });
  assert.equal(module.eventSubscribers[0]?.eventTypes[0], "schedule_run_created");
  assert.equal(module.configuration.sensitiveKeys[0], "serviceToken");
});

test("reference module accepts compatible Core updates and rejects unsupported updates", () => {
  const module = createPartnersGatewayModule({} as Database, {});
  const compatible = composeTaskWeaverModules([module], { coreVersion: "0.2.2" });
  assert.equal(compatible.workers[0]?.id, "partners-gateway-runner");
  assert.equal(compatible.apiRoutes[0]?.path, "/api/v1/pi-agent/worker");
  assert.throws(() => composeTaskWeaverModules([module], { coreVersion: "0.3.0" }),
    (error: unknown) => {
      assert.ok(error instanceof ModuleCompositionError);
      assert.equal(error.code, "core_version_unsupported");
      return true;
    });
});
