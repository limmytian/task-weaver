import test from "node:test";
import assert from "node:assert/strict";
import { readChatStream, SecretTextBuffer } from "./chat-stream";
import { SseDecoder } from "@task-weaver/contracts";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (value: unknown, finish_reason: string | null = null) => frame({ choices: [{ delta: value, finish_reason }] });
async function* bytes(value: string) { const data = Buffer.from(value); for (const byte of data) yield Uint8Array.of(byte); }

test("provider SSE preserves fragmented UTF-8 and redacts keys across deltas", async () => {
  const updates: string[] = [];
  const value = delta({ content: "\u4f60\u597d\uff0c" }) + delta({ content: "secret-" }) + delta({ content: "credential!" }) + delta({}, "stop") + "data: [DONE]\r\n\r\n";
  const turn = await readChatStream(bytes(value), "secret-credential", async text => { updates.push(text); });
  assert.equal(turn.content, "\u4f60\u597d\uff0c[redacted]!");
  assert.equal(updates.join(""), turn.content);
  assert(updates.length > 1);
  const filter = new SecretTextBuffer("secret-credential");
  assert.equal(filter.push("secret-"), ""); assert.equal(filter.finish(), "secret-");
  const ordinary = new SecretTextBuffer("sk-credential");
  assert.equal(ordinary.push("Tasks") + ordinary.finish(), "Tasks");
});

test("tool fragments are assembled and validated only after a complete provider turn", async () => {
  const value = delta({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "create_task", arguments: '{"title":' } }] })
    + delta({ tool_calls: [{ index: 0, function: { arguments: '"Example"}' } }] }) + delta({}, "tool_calls") + "data: [DONE]\n\n";
  const turn = await readChatStream(bytes(value), "credential", async () => { assert.fail("Tool arguments must never be exposed as display text"); });
  assert.deepEqual(turn.toolCalls, [{ id: "call-1", name: "create_task", arguments: '{"title":"Example"}' }]);
  await assert.rejects(readChatStream(bytes(value.replace("data: [DONE]\n\n", "")), "credential", async () => {}));
  await assert.rejects(readChatStream(bytes(delta({ tool_calls: [{ index: 0, id: "bad", type: "function", function: { name: "create_task", arguments: '{"title":' } }] }, "tool_calls") + "data: [DONE]\n\n"), "credential", async () => {}));
  await assert.rejects(readChatStream(bytes(delta({ content: "Partial" }, "length") + "data: [DONE]\n\n"), "credential", async () => {}));
});

test("SSE framing accepts comments and multiline data and rejects truncated/oversized events", () => {
  const decoder = new SseDecoder(100);
  assert.deepEqual(decoder.push(": heartbeat\ndata: first\ndata: second\n\n"), ["first\nsecond"]);
  decoder.finish();
  const partial = new SseDecoder(); partial.push("data: incomplete\n"); assert.throws(() => partial.finish());
  assert.throws(() => new SseDecoder(5).push("data: too large\n\n"));
});
