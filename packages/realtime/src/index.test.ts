import assert from "node:assert/strict";
import test from "node:test";
import { acceptRealtimeSequence } from "./sequence";

test("accepts strictly newer realtime events and flags reconnect gaps", () => {
  assert.deepEqual(acceptRealtimeSequence(0, 1), { accepted: true, missed: false });
  assert.deepEqual(acceptRealtimeSequence(4, 5), { accepted: true, missed: false });
  assert.deepEqual(acceptRealtimeSequence(4, 8), { accepted: true, missed: true });
  assert.deepEqual(acceptRealtimeSequence(8, 8), { accepted: false, missed: false });
  assert.deepEqual(acceptRealtimeSequence(8, 3), { accepted: false, missed: false });
});
