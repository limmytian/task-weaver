import assert from "node:assert/strict";
import test from "node:test";

import { tiAgentRetryBackoffMs } from "./ti-agent";

test("Ti agent retry backoff is exponential and bounded", () => {
  assert.equal(tiAgentRetryBackoffMs(1, 1_000, 10_000), 1_000);
  assert.equal(tiAgentRetryBackoffMs(2, 1_000, 10_000), 2_000);
  assert.equal(tiAgentRetryBackoffMs(3, 1_000, 10_000), 4_000);
  assert.equal(tiAgentRetryBackoffMs(10, 1_000, 10_000), 10_000);
});
