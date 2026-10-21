import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderPluginViewer } from "./plugin-frontend";

const ticket = {
  installationId: "22222222-2222-4222-8222-222222222222", revision: 1,
  manifestHash: "a".repeat(64), bridgeNonce: "b".repeat(43), webOrigin: "https://app.example.test",
  allowedMethods: ["increment"], displayName: "Counter", pluginId: "example/counter",
  artifactUrl: "https://plugins.example.test/artifacts/" + "c".repeat(43),
  expiresAt: new Date(Date.now() + 60000).toISOString(), frontendFormat: "restricted_html_v1",
};

/** Execute the shipped trusted script; this is protocol coverage, not browser sandbox evidence. */
function viewer() {
  const replies: unknown[] = [], requests: Array<{ url: string; init?: RequestInit }> = [];
  const source = { postMessage(message: unknown) { replies.push(message); } };
  let load!: () => void, message!: (event: unknown) => Promise<void>;
  const frame = { contentWindow: source, addEventListener(_name: string, listener: () => void) { load = listener; } };
  const status = { textContent: "", dataset: {} };
  const script = renderPluginViewer(ticket).html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]!;
  runInNewContext(script, {
    document: { getElementById: (id: string) => id === "tw-plugin-frame" ? frame : status },
    window: { addEventListener(_name: string, listener: typeof message) { message = listener; } }, TextEncoder,
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, json: async () => url.endsWith("csrf") ? { csrfToken: "private-host-csrf" } : { result: 7 } };
    },
  });
  const binding = { protocol: 1, installationId: ticket.installationId, revision: ticket.revision, manifestHash: ticket.manifestHash, nonce: ticket.bridgeNonce };
  const invoke = { ...binding, kind: "invoke", requestId: "33333333-3333-4333-8333-333333333333", method: "increment", input: {} };
  const ready = { ...binding, kind: "ready", isolation: { opaqueOrigin: true, coreDomDenied: true, cookiesDenied: true, localStorageDenied: true } };
  const send = (data: unknown, origin = "null", sender: unknown = source) => message({ data, origin, source: sender });
  return { load, send, ready, invoke, requests, replies, source, status };
}

test("shipped viewer rejects spoofed provenance and malformed messages before host requests", async () => {
  const v = viewer(); v.load();
  await v.send(v.invoke);
  await v.send(v.ready, "null", {});
  await v.send(v.invoke);
  assert.equal(v.requests.length, 0, "a different opaque frame cannot initialize this viewer");
  await v.send(v.ready);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const invalid = [null, "invoke", { ...v.invoke, nonce: "wrong" }, { ...v.invoke, installationId: "44444444-4444-4444-8444-444444444444" }, { ...v.invoke, revision: 2 }, { ...v.invoke, manifestHash: "d".repeat(64) }, { ...v.invoke, protocol: 2 }, { ...v.invoke, method: "__tw_preflight" }, { ...v.invoke, requestId: "bad" }, { ...v.invoke, namespace: "other" }, { ...v.invoke, input: { value: "x".repeat(32769) } }, { ...v.invoke, input: cyclic }];
  for (const value of invalid) await v.send(value);
  await v.send(v.invoke, ticket.webOrigin);
  await v.send(v.invoke, "https://unexpected.example.test");
  await v.send(v.invoke, "null", {});
  assert.equal(v.requests.length, 0);
  await v.send(v.invoke);
  assert.equal(v.requests.length, 2, "the same script still accepts the correctly bound frame");
  assert.equal(v.requests[1]!.url, `/api/plugins/${ticket.installationId}/invoke`);
  assert.equal(new Headers(v.requests[1]!.init?.headers).get("x-csrf-token"), "private-host-csrf");
  assert.equal(JSON.stringify(v.replies).includes("private-host-csrf"), false, "frame messages contain no host CSRF credential");
  assert.equal(v.status.textContent, "Updated");
});

test("shipped viewer drops stale replies and requires fresh readiness after frame navigation", async () => {
  const v = viewer(); v.load(); await v.send(v.ready);
  const pending = v.send(v.invoke);
  v.load();
  await pending;
  assert.equal(v.replies.some(reply => Boolean(reply && typeof reply === "object" && "kind" in reply && reply.kind === "result")), false, "a pending result cannot cross the frame load epoch");
  const count = v.requests.length;
  await v.send(v.invoke);
  assert.equal(v.requests.length, count, "a reloaded frame must complete readiness again");
  await v.send({ ...v.ready, isolation: { ...v.ready.isolation, cookiesDenied: false } });
  await v.send(v.invoke);
  assert.equal(v.requests.length, count, "failed isolation cannot enable backend calls");
});
