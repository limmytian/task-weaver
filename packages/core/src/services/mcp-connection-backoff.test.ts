import assert from "node:assert/strict";
import test from "node:test";
import { McpConnectionBackoff } from "./mcp-connection-backoff";

test("connection failures cool down one partition without delaying unrelated servers", () => {
  let time = 0;
  const backoff = new McpConnectionBackoff(() => time);
  backoff.failed("failed");
  assert.throws(() => backoff.assertReady("failed"));
  backoff.assertReady("independent");
  time = 1000; backoff.assertReady("failed");
  backoff.failed("failed"); time = 2000;
  assert.throws(() => backoff.assertReady("failed"));
  time = 3000; backoff.assertReady("failed");
  backoff.succeeded("failed"); backoff.failed("failed");
  time = 4000; backoff.assertReady("failed");
});
