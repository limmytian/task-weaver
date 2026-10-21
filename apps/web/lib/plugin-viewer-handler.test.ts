import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createPluginViewerHandler } from "./plugin-viewer-handler";

const id = "11111111-1111-4111-8111-111111111111";
const ticket = { installationId: id, revision: 1, manifestHash: "a".repeat(64), bridgeNonce: randomBytes(32).toString("base64url"), webOrigin: "https://app.example.test", allowedMethods: ["read"], displayName: "Counter", pluginId: "fixture/counter", artifactUrl: `https://plugins.example.test/artifacts/${randomBytes(32).toString("base64url")}`, expiresAt: new Date(Date.now() + 60000).toISOString(), frontendFormat: "restricted_html_v1" };
const runtime = () => ({ db: {}, auth: { assertOrigin() {}, verify: async () => ({ credential: { kind: "session" }, actor: { type: "human" } }), trustedOrigins: new Set([ticket.webOrigin]), authentication: { assertMutation() {} } } }) as unknown as ReturnType<Parameters<typeof createPluginViewerHandler>[0]>;
const env = { TW_API_URL: "http://api.internal:3001", TW_AUTH_BASE_URL: "https://api.example.test" };

test("viewer uses the actual HTTP host behind Next internals and never exposes forwarded session material", async () => {
  let calls = 0;
  const handler = createPluginViewerHandler(runtime, env, async (input, init) => {
    calls++; assert.equal(input, `http://api.internal:3001/api/v1/plugins/${id}/viewer`);
    assert.equal(new Headers(init?.headers).get("cookie"), "fixture-session=private-fixture-value");
    assert.equal(init?.redirect, "error");
    return Response.json(ticket);
  });
  const response = await handler(new Request(`http://internal-next:3000/plugins/${id}`, { headers: { host: "app.example.test", cookie: "fixture-session=private-fixture-value" } }), id, "viewer");
  assert.equal(response.status, 200); assert.equal(calls, 1);
  const html = await response.text();
  assert.ok(html.includes('sandbox="allow-scripts"'));
  assert.ok(!html.includes("private-fixture-value"));
  assert.ok(response.headers.get("content-security-policy")?.includes(`frame-src ${ticket.artifactUrl}`));
  const denied = await handler(new Request(`https://app.example.test/plugins/${id}`, { headers: { host: "evil.example.test", cookie: "fixture-session=private-fixture-value" } }), id, "viewer");
  assert.equal(denied.status, 400);
});

test("viewer rejects same-host artifacts, changed application origins and browser API-key identity", async () => {
  for (const altered of [{ ...ticket, artifactUrl: `https://app.example.test/artifacts/${randomBytes(32).toString("base64url")}` }, { ...ticket, webOrigin: "https://other.example.test" }]) {
    const handler = createPluginViewerHandler(runtime, env, async () => Response.json(altered));
    assert.equal((await handler(new Request(`https://app.example.test/plugins/${id}`), id, "viewer")).status, 400);
  }
  const apiRuntime = () => ({ ...runtime(), auth: { ...runtime().auth, verify: async () => ({ credential: { kind: "api_key" }, actor: { type: "agent" } }) } }) as unknown as ReturnType<Parameters<typeof createPluginViewerHandler>[0]>;
  const handler = createPluginViewerHandler(apiRuntime, env, async () => { throw new Error("Must not forward an Agent credential into the human viewer"); });
  assert.equal((await handler(new Request(`https://app.example.test/plugins/${id}`), id, "viewer")).status, 401);
});
