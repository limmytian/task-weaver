import assert from "node:assert/strict";
import test from "node:test";
import { createPluginManagementHandler } from "./plugin-management-handler";
import { capabilityDigest, pluginPermissionDiff } from "@task-weaver/core";
import { pluginManifestSchema } from "@task-weaver/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const manifest = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: id, version: "1.0", manifestHash: "a".repeat(64) }, backend: { profileId: "fixture", profileHash: "b".repeat(64), entryPath: "run.sh" }, permissions: ["backend.execute"], methods: [{ name: "read", access: "read" }] });
let csrfChecks = 0;
const runtime = () => ({ auth: { assertOrigin() {}, verify: async () => ({ credential: { kind: "session" }, actor: { type: "human" } }), authentication: { assertMutation() { csrfChecks++; } } } }) as unknown as ReturnType<Parameters<typeof createPluginManagementHandler>[0]>;
const env = { TW_API_URL: "http://api.internal:3001" };
const mutation = (body: unknown) => new Request("https://app.example.test/api/plugin-management", { method: "POST", headers: { cookie: "session=fixture-private", authorization: "Bearer must-not-forward", origin: "https://app.example.test", "x-csrf-token": "fixture-csrf" }, body: JSON.stringify(body) });

test("management review reads the current upstream manifest and never executes an operation", async () => {
  let calls = 0;
  const handler = createPluginManagementHandler(runtime, env, async (url, init) => {
    calls++; assert.equal(url, `${env.TW_API_URL}/api/v1/plugins/${id}`); assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers); assert.equal(headers.get("authorization"), null); assert.equal(headers.get("cookie"), "session=fixture-private"); assert.equal(init?.redirect, "error");
    return Response.json({ pluginId: manifest.pluginId, revision: 7, manifest });
  });
  const next = { ...manifest, version: "1.1.0", permissions: [...manifest.permissions, "storage.read" as const] };
  const response = await handler(mutation({ manifest: next, installationId: id }), ["review"]);
  assert.equal(response.status, 200); const review = await response.json();
  assert.equal(review.currentRevision, 7); assert.equal(review.manifestHash, capabilityDigest(next)); assert.deepEqual(review.permissionDiff, pluginPermissionDiff(manifest, next)); assert.equal(calls, 1); assert.ok(csrfChecks > 0);
});

test("management proxies only bounded approved paths and retains an identical mutation retry body", async () => {
  const body = { action: "disable", expectedRevision: 7, confirmed: true, idempotencyKey: id };
  const seen: string[] = [];
  const handler = createPluginManagementHandler(runtime, env, async (url, init) => {
    assert.equal(url, `${env.TW_API_URL}/api/v1/plugins/${id}/status`); seen.push(init?.body as string);
    return Response.json({ currentRevision: 8 });
  });
  for (let i = 0; i < 2; i++) assert.equal((await handler(mutation(body), [id, "status"])).status, 200);
  assert.equal(seen[0], seen[1]); assert.equal(JSON.parse(seen[0]!).idempotencyKey, id);
  for (const path of [[id, "invoke"], [id, "../status"], ["https://evil.example.test"], [id, "status", "extra"]]) assert.ok((await handler(mutation(body), path)).status >= 400);
  assert.equal(seen.length, 2);
  assert.equal((await handler(mutation({ ...body, force: true }), [id, "status"])).status, 400);
  assert.equal((await handler(new Request("https://app.example.test/api/plugin-management?scope=personal&projectId=" + id), [])).status, 400);
  assert.equal((await handler(new Request("https://app.example.test/api/plugin-management", { method: "POST", body: "x".repeat(131073) }), [])).status, 400);
});

test("management rejects API-key identities, CSRF failures and hides upstream failures/addresses", async () => {
  const apiRuntime = () => ({ ...runtime(), auth: { ...runtime().auth, verify: async () => ({ credential: { kind: "api_key" }, actor: { type: "human" } }) } }) as unknown as ReturnType<Parameters<typeof createPluginManagementHandler>[0]>;
  const noFetch: typeof fetch = async () => { throw new Error("must not forward"); };
  assert.equal((await createPluginManagementHandler(apiRuntime, env, noFetch)(new Request("https://app.example.test/api/plugin-management"), [])).status, 401);
  const denied = () => ({ ...runtime(), auth: { ...runtime().auth, authentication: { assertMutation() { throw new Error("CSRF rejected"); } } } }) as unknown as ReturnType<Parameters<typeof createPluginManagementHandler>[0]>;
  assert.ok((await createPluginManagementHandler(denied, env, noFetch)(mutation({}), [])).status >= 400);
  const handler = createPluginManagementHandler(runtime, env, async () => new Response("private-upstream-secret", { status: 500 }));
  const response = await handler(new Request("https://app.example.test/api/plugin-management"), []);
  assert.equal(response.status, 502); assert.equal((await response.text()).includes("private-upstream-secret"), false);
  const detail = createPluginManagementHandler(runtime, env, async () => Response.json({ id, pluginId: manifest.pluginId, manifest, status: "active", revision: 7, manifestHash: capabilityDigest(manifest), viewerUrl: "https://private-internal.example.test/plugins/secret" }));
  const text = await (await detail(new Request("https://app.example.test/api/plugin-management"), [id])).text();
  assert.equal(text.includes("private-internal"), false); assert.equal(JSON.parse(text).viewerAvailable, true);
});
