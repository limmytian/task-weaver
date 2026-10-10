import test from "node:test";
import assert from "node:assert/strict";
import { readAssistantStream, sendAssistantStream, AssistantStreamError } from "./assistant-stream";
const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

test("Chat displays text before completion and consumes heartbeat frames", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const events: string[] = [];
  let complete = false;
  const result = readAssistantStream<{ id: string }>(body, event => { events.push(event.type); }).then(value => { complete = true; return value; });
  controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
  const text = frame({ type: "text", delta: "First fragment" });
  for (const byte of text) controller.enqueue(Uint8Array.of(byte));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["text"]); assert.equal(complete, false);
  controller.enqueue(frame({ type: "completed", result: { id: "persisted" } }));
  assert.deepEqual(await result, { id: "persisted" });
});

test("Chat interrupted streams require recovery and permission errors stay terminal", async () => {
  const interrupted = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "text", delta: "Partial" })); controller.close(); } });
  await assert.rejects(readAssistantStream(interrupted, () => {}), /before the result was saved/);
  const rejected = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "failed", message: "Permission denied", code: "permission_denied", httpStatus: 403 })); controller.close(); } });
  await assert.rejects(readAssistantStream(rejected, () => {}), error => error instanceof AssistantStreamError && error.data.httpStatus === 403);
});

test("Chat POST carries browser CSRF protection and never retries an interrupted submission", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "/api/auth/csrf") return Response.json({ csrfToken: "fixture-csrf" });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "text", delta: "Partial" })); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(sendAssistantStream({ message: "A single original request" }, () => {}));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "/api/assistant/stream");
    assert.equal(calls[1].options?.method, "POST");
    assert.equal(calls[1].options?.credentials, "same-origin");
    assert.equal(new Headers(calls[1].options?.headers).get("x-csrf-token"), "fixture-csrf");
  } finally { globalThis.fetch = original; }
});
