import assert from "node:assert/strict";
import test from "node:test";

import { piAgentRetryBackoffMs } from "./pi-agent";

test("Ti agent retry backoff is exponential and bounded", () => {
  assert.equal(piAgentRetryBackoffMs(1, 1_000, 10_000), 1_000);
  assert.equal(piAgentRetryBackoffMs(2, 1_000, 10_000), 2_000);
  assert.equal(piAgentRetryBackoffMs(3, 1_000, 10_000), 4_000);
  assert.equal(piAgentRetryBackoffMs(10, 1_000, 10_000), 10_000);
});
