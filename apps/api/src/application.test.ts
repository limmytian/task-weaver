import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { Database } from "@task-weaver/db";
import type { RealtimeEvent } from "@task-weaver/realtime";
import { createApiApplication } from "./application";

function fixture() {
  const listeners: Array<(event: RealtimeEvent) => void> = [];
  let shutdowns = 0;
  const application = createApiApplication({
    db: {} as Database,
    databaseUrl: "postgresql://unused",
    env: {
      TW_PRESET_SKILLS_SYNC: "disabled",
      TW_AUTH_SECRET: randomBytes(32).toString("hex"),
      TW_AUTH_BASE_URL: "http://localhost:3001",
    },
    runtimeDependencies: {
      initRealtime: async () => undefined,
      shutdownRealtime: async () => {
        shutdowns++;
      },
      subscribe(listener) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  });
  return { application, listeners, shutdowns: () => shutdowns };
}

test("health remains public and unguarded Gateway controls reject anonymous requests", async () => {
  const { application } = fixture();
  const status = await application.app.request("/api/v1/ti/worker/status");
  assert.equal(status.status, 401);
  const health = await application.app.request("/health");
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ok");
});

test("protected defaults reject forged Actor headers and malformed credentials", async () => {
  const { application } = fixture();
  for (const path of [
    "/api/v1/projects",
    "/api/v1/graphql",
    "/api/v1/api-keys",
    "/api/v1/daemons/events",
    "/api/v1/auth/me",
  ]) {
    const response = await application.app.request(path, {
      headers: { "X-Actor-Id": "forged", "X-Actor-Type": "agent" },
    });
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const value of ["Basic credential", "Bearer invalid", ""]) {
    const response = await application.app.request("/health", {
      headers: { authorization: value },
    });
    assert.equal(response.status, 401);
  }
});

test("authentication configuration is mandatory and CORS is exact", async () => {
  assert.throws(
    () =>
      createApiApplication({
        db: {} as Database,
        databaseUrl: "unused",
        env: {},
      }),
    /TW_AUTH_SECRET/,
  );
  const { application } = fixture();
  const bad = await application.app.request("/api/v1/auth/csrf", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const good = await application.app.request("/api/v1/auth/csrf", {
    headers: { origin: "http://localhost:3001" },
  });
  assert.equal(good.status, 200);
  assert.equal(
    good.headers.get("access-control-allow-origin"),
    "http://localhost:3001",
  );
  assert.equal(good.headers.get("access-control-allow-credentials"), "true");
  const preflight = await application.app.request("/api/v1/auth/login", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3001",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-csrf-token",
    },
  });
  assert.equal(preflight.status, 204);
  const forged = await application.app.request("/api/v1/auth/login", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3001",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-actor-id",
    },
  });
  assert.equal(forged.status, 403);
  const malformed = await application.app.request("/api/v1/auth/login", {
    method: "OPTIONS", headers: { origin: "http://localhost:3001", authorization: "Basic invalid", "access-control-request-method": "POST" },
  });
  assert.equal(malformed.status, 401);
});

test("first-party lifecycle starts once and releases realtime subscriptions", async () => {
  const f = fixture();
  await f.application.start();
  await f.application.start();
  assert.equal(
    f.listeners.length,
    1,
    "Only the authorized webhook subscriber is enabled",
  );
  await f.application.stop();
  assert.equal(f.listeners.length, 0);
  assert.equal(f.shutdowns(), 1);
  await assert.rejects(f.application.start(), /cannot restart/);
});
