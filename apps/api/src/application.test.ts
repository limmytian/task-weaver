import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { Database } from "@task-weaver/db";
import { createDefaultRuntimePorts } from "@task-weaver/core";
import {
  TASK_WEAVER_MODULE_API_VERSION,
  defineTaskWeaverModule,
  ModuleCompositionError,
} from "@task-weaver/module-sdk";
import type { RealtimeEvent } from "@task-weaver/realtime";
import { createApiApplication, TASK_WEAVER_CORE_VERSION } from "./application";

function testDependencies() {
  const listeners: Array<(event: RealtimeEvent) => void> = [];
  return {
    listeners,
    dependencies: {
      initRealtime: async () => undefined,
      shutdownRealtime: async () => undefined,
      subscribe: (listener: (event: RealtimeEvent) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  };
}

function createOptions() {
  const realtime = testDependencies();
  return {
    realtime,
    options: {
      db: {} as Database,
      databaseUrl: "postgresql://unused",
      ports: createDefaultRuntimePorts(),
      env: { TW_PRESET_SKILLS_SYNC: "disabled" },
      runtimeDependencies: realtime.dependencies,
    },
  };
}

test("composes Core and module routes with health checks", async () => {
  const router = new Hono().get("/", (context) => context.json({ source: "module" }));
  const module = defineTaskWeaverModule({
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: "example.api",
      name: "Example API",
      version: "1.0.0",
      supportedCoreVersion: `^${TASK_WEAVER_CORE_VERSION}`,
    },
    apiRoutes: [{ id: "example", method: "GET", path: "/api/v1/example", route: router }],
    healthChecks: [{ id: "example", check: () => ({ status: "degraded" as const }) }],
  });
  const { options } = createOptions();
  const application = createApiApplication({ ...options, modules: [module] });

  const response = await application.app.request("/api/v1/example");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { source: "module" });
  const health = await application.app.request("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, "degraded");
});

test("registers the Partners Gateway reference module and preserves worker controls", async () => {
  const { options } = createOptions();
  const application = createApiApplication(options);
  assert.equal(
    application.composition.modules.some((module) => module.manifest.id === "task-weaver.partners-gateway"),
    true,
  );
  assert.equal(
    application.composition.modules.some((module) => module.manifest.capabilities?.includes("partners-gateway.execution")),
    true,
  );
  const status = await application.app.request("/api/v1/pi-agent/worker/status");
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { enabled: boolean }).enabled, false);
  const health = await application.app.request("/api/v1/pi-agent/worker/health");
  assert.equal(health.status, 503);
});

test("validates module configuration before startup", () => {
  const { options } = createOptions();
  assert.throws(() => createApiApplication({
    ...options,
    modules: [defineTaskWeaverModule({
      manifest: {
        apiVersion: TASK_WEAVER_MODULE_API_VERSION,
        id: "example.future",
        name: "Future module",
        version: "1.0.0",
        supportedCoreVersion: ">=2.0.0",
      },
    })],
  }), (error: unknown) => {
    assert.ok(error instanceof ModuleCompositionError);
    assert.equal(error.code, "core_version_unsupported");
    return true;
  });
});

test("starts subscribers and workers and stops workers in reverse order", async () => {
  const lifecycle: string[] = [];
  const { options, realtime } = createOptions();
  const module = defineTaskWeaverModule({
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: "example.lifecycle",
      name: "Lifecycle module",
      version: "1.0.0",
      supportedCoreVersion: `^${TASK_WEAVER_CORE_VERSION}`,
    },
    workers: [
      { id: "first", start: () => { lifecycle.push("start:first"); }, stop: () => { lifecycle.push("stop:first"); } },
      { id: "second", start: () => { lifecycle.push("start:second"); }, stop: () => { lifecycle.push("stop:second"); } },
    ],
    eventSubscribers: [{
      id: "tasks",
      eventTypes: ["task_updated"],
      handle: () => { lifecycle.push("event:task_updated"); },
    }],
  });
  const application = createApiApplication({ ...options, modules: [module] });

  await application.start();
  assert.deepEqual(lifecycle, ["start:first", "start:second"]);
  realtime.listeners.at(-1)?.({
    type: "task_updated",
    projectId: null,
    taskId: "00000000-0000-4000-8000-000000000000",
  } as RealtimeEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.at(-1), "event:task_updated");
  await application.stop();
  assert.deepEqual(lifecycle.slice(-3), ["event:task_updated", "stop:second", "stop:first"]);
  assert.equal(realtime.listeners.length, 0);
  await assert.rejects(() => application.start(), /cannot restart/);
});

test("rolls back started workers when startup fails", async () => {
  const lifecycle: string[] = [];
  const { options, realtime } = createOptions();
  const application = createApiApplication({
    ...options,
    modules: [defineTaskWeaverModule({
      manifest: {
        apiVersion: TASK_WEAVER_MODULE_API_VERSION,
        id: "example.failure",
        name: "Failure module",
        version: "1.0.0",
        supportedCoreVersion: `^${TASK_WEAVER_CORE_VERSION}`,
      },
      workers: [
        { id: "started", start: () => { lifecycle.push("start"); }, stop: () => { lifecycle.push("stop"); } },
        { id: "failing", start: () => { throw new Error("startup failed"); } },
      ],
    })],
  });

  await assert.rejects(() => application.start(), /startup failed/);
  assert.deepEqual(lifecycle, ["start", "stop"]);
  assert.equal(realtime.listeners.length, 0);
});
