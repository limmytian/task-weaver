import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { pluginManifestSchema, pluginFrontendOriginsSchema, pluginInvokeMessageSchema } from "@task-weaver/contracts";
import { compilePluginFrontend, renderPluginFrontend, renderPluginViewer } from "./plugin-frontend";

const manifest = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "example/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: "11111111-1111-4111-8111-111111111111", version: "1.0", manifestHash: "a".repeat(64) }, permissions: ["ui.render", "backend.execute", "storage.read", "storage.write"], frontend: { entryPath: "ui/index.html" }, backend: { profileId: "approved", profileHash: "b".repeat(64), entryPath: "backend/run.js" }, methods: [{ name: "increment", access: "write" }] });
const binding = { installationId: "22222222-2222-4222-8222-222222222222", revision: 1, manifestHash: "c".repeat(64), bridgeNonce: randomBytes(32).toString("base64url"), webOrigin: "https://app.example.test", allowedMethods: ["increment"] };

test("plugin UI compiler supports declarative state buttons and rejects executable/network/clobbering markup", () => {
  const ui = compilePluginFrontend('<h1>Counter</h1><button data-tw-method="increment" data-tw-input=\'{"amount":1}\'>Add one</button><output data-tw-result>0</output>', manifest);
  assert.equal(ui.format, "restricted_html_v1");
  assert.ok(JSON.stringify(ui).includes('"method":"increment"'));
  for (const markup of [
    '<script>fetch("https://evil.example")</script>', '<img src="https://evil.example">', '<iframe srcdoc="attack"></iframe>',
    '<svg><script>alert(1)</script></svg>', '<math><mi>attack</mi></math>', '<style>body{background:url(https://evil.example)}</style>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">', '<base href="https://evil.example">', '<a href="https://evil.example">click</a>',
    '<button onclick="alert(1)" data-tw-method="increment">click</button>', '<p id="parent">clobber</p>', '<form action="https://evil.example"><button>submit</button></form>',
    '<button data-tw-method="other">undeclared</button>', '<button>no binding</button>', '<button data-tw-method="increment" data-tw-input="bad-json">bad</button>',
    '<div style="background:url(https://evil.example)">CSS</div>', '<template><script>attack</script></template>',
    '<head><script>attack</script></head><body>text</body>',
  ]) assert.throws(() => compilePluginFrontend(markup, manifest), (error: unknown) => error instanceof Error, markup);
  assert.throws(() => compilePluginFrontend('<div>'.repeat(18) + 'deep' + '</div>'.repeat(18), manifest));
  assert.throws(() => compilePluginFrontend('<p>x</p>'.repeat(513), manifest));
  assert.throws(() => compilePluginFrontend('x'.repeat(131073), manifest));
});

test("plugin renderer embeds only escaped data and a trusted nonce script with closed network/frame policy", () => {
  const ui = compilePluginFrontend('<p>&lt;/script&gt;&lt;script&gt;attack&lt;/script&gt;</p><button data-tw-method="increment">Go</button>', manifest);
  const result = renderPluginFrontend(ui, binding);
  assert.equal((result.html.match(/<script /g) ?? []).length, 1);
  assert.equal((result.html.match(/<\/script>/g) ?? []).length, 1);
  assert.ok(result.html.includes('JSON.parse('));
  assert.ok(result.html.includes('\\u003c/script>'));
  assert.ok(result.headers["content-security-policy"].includes("sandbox allow-scripts"));
  assert.ok(result.headers["content-security-policy"].includes("connect-src 'none'"));
  assert.ok(result.headers["content-security-policy"].includes("frame-src 'none'"));
  assert.ok(!result.headers["content-security-policy"].includes("unsafe-inline"));
  assert.throws(() => renderPluginFrontend(JSON.parse(JSON.stringify(ui)), binding), /compiled/);
});

test("plugin frame origins and message contracts reject cookie-sharing ports and spoofed namespaces", () => {
  assert.ok(pluginFrontendOriginsSchema.safeParse({ webOrigin: "https://app.example.test", apiOrigin: "https://api.example.test", artifactOrigin: "https://plugins.example.test" }).success);
  assert.equal(pluginFrontendOriginsSchema.safeParse({ webOrigin: "http://localhost:3000", apiOrigin: "http://localhost:3001", artifactOrigin: "http://localhost:3010" }).success, false);
  assert.equal(pluginFrontendOriginsSchema.safeParse({ webOrigin: "invalid", apiOrigin: "https://api.example.test", artifactOrigin: "https://plugins.example.test" }).success, false);
  assert.ok(pluginFrontendOriginsSchema.safeParse({ webOrigin: "http://127.0.0.1:3000", apiOrigin: "http://127.0.0.1:3001", artifactOrigin: "http://localhost:3010" }).success);
  const message = { protocol: 1, kind: "invoke", installationId: binding.installationId, revision: 1, manifestHash: binding.manifestHash, nonce: binding.bridgeNonce, requestId: "33333333-3333-4333-8333-333333333333", method: "increment", input: {} };
  assert.ok(pluginInvokeMessageSchema.safeParse(message).success);
  let getterExecuted = false;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterExecuted = true; return 1; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(pluginInvokeMessageSchema.safeParse({ ...message, input: getter }).success, false);
  assert.equal(pluginInvokeMessageSchema.safeParse({ ...message, input: cyclic }).success, false);
  assert.equal(getterExecuted, false);
  for (const patch of [{ namespace: "other" }, { sql: "SELECT 1" }, { nonce: "short" }, { revision: 0 }, { method: "__tw_preflight" }]) assert.equal(pluginInvokeMessageSchema.safeParse({ ...message, ...patch }).success, false);
});


test("trusted parent viewer escapes manifest labels and pins its only frame navigation target", () => {
  const ticket = { ...binding, displayName: '<script>attack</script>', pluginId: 'example/counter', artifactUrl: `https://plugins.example.test/artifacts/${randomBytes(32).toString('base64url')}`, expiresAt: new Date(Date.now() + 60000).toISOString(), frontendFormat: 'restricted_html_v1' };
  const rendered = renderPluginViewer(ticket);
  assert.equal((rendered.html.match(/<script /g) ?? []).length, 1);
  assert.ok(!rendered.html.includes('<script>attack</script>'));
  assert.ok(rendered.html.includes('&lt;script&gt;attack&lt;/script&gt;'));
  assert.ok(rendered.headers['content-security-policy'].includes(`frame-src ${ticket.artifactUrl}`));
  assert.throws(() => renderPluginViewer({ ...ticket, artifactUrl: ticket.artifactUrl + '?redirect=evil' }));
});
