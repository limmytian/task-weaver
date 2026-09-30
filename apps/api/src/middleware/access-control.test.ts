import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createDefaultRuntimePorts } from "@task-weaver/core/default-ports";
import type { TaskWeaverRuntimePorts } from "@task-weaver/module-sdk/ports";
import { accessControlMiddleware } from "./access-control";
import type { Env } from "./actor";

function testApp(ports: TaskWeaverRuntimePorts) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("actor", { id: "test-user", type: "human" });
    c.set("ports", ports);
    await next();
  });
  app.use("*", accessControlMiddleware);
  app.get("/api/v1/projects", (c) => c.json({ ok: true }));
  return app;
}

test("default runtime ports preserve API access", async () => {
  const response = await testApp(createDefaultRuntimePorts()).request("/api/v1/projects");
  assert.equal(response.status, 200);
});

test("server middleware denies authorization even when a route is visible", async () => {
  const ports = createDefaultRuntimePorts();
  ports.authorization = {
    authorize: () => ({ allowed: false, reason: "Read access denied" }),
  };
  const response = await testApp(ports).request("/api/v1/projects");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Read access denied",
    code: "authorization_denied",
  });
});

test("server middleware enforces entitlements after authorization", async () => {
  const ports = createDefaultRuntimePorts();
  ports.entitlements = {
    checkEntitlement: () => ({ allowed: false, reason: "API capability unavailable" }),
  };
  const response = await testApp(ports).request("/api/v1/projects");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "entitlement_denied");
});
