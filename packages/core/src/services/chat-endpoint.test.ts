import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { requestChatTurn, requestChatConnection } from "./chat-endpoint";

test("local HTTP models stream without credentials and still refuse redirects", async () => {
  let redirected = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.url, "/v1/chat/completions");
    if (redirected) { response.writeHead(302, { location: "http://127.0.0.1/other" }); response.end(); return; }
    response.setHeader("Content-Type", "text/event-stream");
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Local model reply" }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    let streamed = "";
    const turn = await requestChatTurn(url, "", { model: "fixture", messages: [] }, performance.now() + 5000, async delta => { streamed += delta; });
    assert.equal(turn.content, "Local model reply"); assert.equal(streamed, turn.content);
    redirected = true;
    await assert.rejects(requestChatTurn(url, "", {}, performance.now() + 5000), /Model request failed/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("connection tests accept bounded thinking responses while Chat rejects empty replies", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning: "Fixture thinking" }, finish_reason: "length" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await requestChatConnection(url, "", "fixture");
    await assert.rejects(requestChatTurn(url, "", {}, performance.now() + 5000), /did not include readable content/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("deployment proxies route model requests while NO_PROXY keeps local models direct", async () => {
  const original = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  const paths: string[] = [];
  const proxy = createServer((request, response) => {
    paths.push(request.url!);
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "Proxy reply" } }] }));
  });
  const direct = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "Direct reply" } }] }));
  });
  proxy.listen(0, "127.0.0.1"); direct.listen(0, "127.0.0.1");
  await Promise.all([once(proxy, "listening"), once(direct, "listening")]);
  try {
    process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    delete process.env.http_proxy; delete process.env.no_proxy;
    process.env.NO_PROXY = "";
    assert.equal((await requestChatTurn("http://localhost:1/v1", "fixture-key", {})).content, "Proxy reply");
    assert.deepEqual(paths, ["http://localhost:1/v1/chat/completions"]);
    process.env.NO_PROXY = "127.0.0.1,localhost";
    assert.equal((await requestChatTurn(`http://127.0.0.1:${(direct.address() as { port: number }).port}/v1`, "", {})).content, "Direct reply");
    assert.equal(paths.length, 1);
  } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    proxy.closeAllConnections(); direct.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => direct.close(() => resolve()))]);
  }
});
