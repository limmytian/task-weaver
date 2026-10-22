import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { requestTiModelTurn } from "./ti-model-turn";

test("shared transport records provider usage and returns tools", async () => {
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ model: "actual-model",
    usage: { prompt_tokens: 42, completion_tokens: 8 },
    choices: [{ message: { content: null, tool_calls: [{ id: "one", type: "function", function: { name: "read", arguments: "{}" } }] } }],
  })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const outcomes: string[] = [];
  let observed: unknown;
  try {
    const result = await requestTiModelTurn({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "", proxy: { proxyMode: "direct" },
      payload: { model: "configured", messages: [] }, deadline: performance.now() + 5_000,
      beginUsage: async () => ({ observe(value, model) { observed = { value, model }; }, async finish(outcome) { outcomes.push(outcome); } }),
    });
    assert.equal(result.toolCalls[0]?.name, "read");
    assert.deepEqual(observed, { value: { prompt_tokens: 42, completion_tokens: 8 }, model: "actual-model" });
    assert.deepEqual(outcomes, ["succeeded"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("cancelling an in-flight model request closes transport and records cancellation", async () => {
  const controller = new AbortController();
  const server = http.createServer(request => { request.resume(); controller.abort(new DOMException("Cancelled", "AbortError")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const outcomes: string[] = [];
  try {
    await assert.rejects(requestTiModelTurn({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "", proxy: { proxyMode: "direct" },
      payload: {}, deadline: performance.now() + 5_000, signal: controller.signal,
      beginUsage: async () => ({ observe() {}, async finish(outcome) { outcomes.push(outcome); } }),
    }), error => error instanceof Error && error.name === "AbortError");
    assert.deepEqual(outcomes, ["cancelled"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
