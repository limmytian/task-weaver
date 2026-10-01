import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@task-weaver/db";
import type { RealtimeEvent } from "@task-weaver/realtime";
import { createApiApplication } from "./application";

function fixture() {
  const listeners: Array<(event: RealtimeEvent) => void> = [];
  let shutdowns = 0;
  const application = createApiApplication({
    db: {} as Database, databaseUrl: "postgresql://unused",
    env: { TW_PRESET_SKILLS_SYNC: "disabled" },
    runtimeDependencies: {
      initRealtime: async () => undefined,
      shutdownRealtime: async () => { shutdowns++; },
      subscribe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); },
    },
  });
  return { application, listeners, shutdowns: () => shutdowns };
}

test("first-party Gateway controls and health remain available without Pro composition", async () => {
  const { application } = fixture();
  const status = await application.app.request("/api/v1/pi-agent/worker/status");
  assert.equal(status.status, 200);
  const health = await application.app.request("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, "ok");
});

test("first-party lifecycle starts once and releases realtime subscriptions", async () => {
  const f = fixture();
  await f.application.start();
  await f.application.start();
  assert.equal(f.listeners.length, 2);
  await f.application.stop();
  assert.equal(f.listeners.length, 0);
  assert.equal(f.shutdowns(), 1);
  await assert.rejects(f.application.start(), /cannot restart/);
});
