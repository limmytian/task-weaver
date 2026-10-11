import assert from "node:assert/strict";
import test from "node:test";
import { readTextPreview } from "./text-attachment-preview";

test("text preview preserves split UTF-8 characters and literal markup", async () => {
  const bytes = new TextEncoder().encode("你好 <script>fixture</script>");
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 2));
    controller.enqueue(bytes.subarray(2));
    controller.close();
  } });
  assert.deepEqual(await readTextPreview(new Response(stream)), { text: "你好 <script>fixture</script>", truncated: false });
});

test("text preview bounds bytes and cancels the remaining transfer", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("0123456789")); }, cancel() { cancelled = true; } });
  assert.deepEqual(await readTextPreview(new Response(stream), 4), { text: "0123", truncated: true });
  assert.equal(cancelled, true);
  await assert.rejects(readTextPreview(new Response(null, { status: 401 })), /unavailable/);
});
