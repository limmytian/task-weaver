import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { compilePluginFrontend, renderPluginFrontend, pluginManifestSchema } from "@task-weaver/core";
import { startPluginBrowserProbeProxy } from "./plugin-browser-probes";

const port = (server: Server) => { const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; };
test("disposable probes preserve shipped sandbox/CSP and instrument only fixed renderer responses", async t => {
  const manifest = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/probe", version: "1.0.0", displayName: "Probe", artifact: { packageId: "11111111-1111-4111-8111-111111111111", version: "1.0", manifestHash: "a".repeat(64) }, permissions: ["ui.render"], frontend: { entryPath: "page.html" } });
  const rendered = renderPluginFrontend(compilePluginFrontend("<p>Fixture</p>", manifest), { installationId: "22222222-2222-4222-8222-222222222222", revision: 1, manifestHash: "b".repeat(64), bridgeNonce: "c".repeat(43), webOrigin: "http://127.0.0.1:3000", allowedMethods: [] });
  const upstream = createServer((request, response) => {
    if (request.url === "/asset") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end("unchanged bytes"); return; }
    response.writeHead(200, { ...rendered.headers, "content-length": Buffer.byteLength(rendered.html) }); response.end(rendered.html);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const proxy = await startPluginBrowserProbeProxy({ port: 0, upstreamPort: port(upstream), role: "artifact", webOrigin: "http://127.0.0.1:3000", apiOrigin: "http://127.0.0.1:3001", sinkOrigin: "http://localhost:3010", report: async () => ({ receipts: 0 }) });
  t.after(proxy.stop);
  const base = `http://127.0.0.1:${port(proxy.server)}`;
  const result = await fetch(base + "/artifacts/" + "d".repeat(43));
  assert.equal(result.headers.get("content-security-policy"), rendered.headers["content-security-policy"], "probes cannot relax browser policy");
  assert.equal(result.headers.get("permissions-policy"), rendered.headers["permissions-policy"]);
  const html = await result.text();
  assert.ok(html.includes("Run sandbox probes"));
  assert.ok(html.includes("Send invalid bound-frame messages"));
  const nonces = [...html.matchAll(/<script nonce="([^"]+)">/g)].map(match => match[1]);
  assert.equal(nonces.length, 2); assert.equal(nonces[0], nonces[1], "only the explicit trusted fixture adds code under the unchanged script nonce");
  assert.equal(await (await fetch(base + "/ordinary-page")).text(), rendered.html);
  assert.equal(await (await fetch(base + "/asset")).text(), "unchanged bytes");
  assert.equal(proxy.sinkRequests(), 0);
  await fetch(base + "/fixture-probe-sink/control");
  assert.equal(proxy.sinkRequests(), 1, "the sink counter detects a request when it actually arrives");
});
