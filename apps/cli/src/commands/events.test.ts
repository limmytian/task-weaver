import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerEvents } from "./events.js";

test("watch resumes at checkpoint, advances only locally and stops on expiration", async () => {
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const calls: string[] = [], output: unknown[] = [];
  const old = { ...process.env };
  process.env.TW_CONFIG_DIR = "/nonexistent/tw-event-test";
  process.env.TW_API_URL = "http://localhost";
  process.env.TW_CLIENT_ID = "fixture"; process.env.TW_NODE_ID = "fixture";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init?.method} ${url.pathname}${url.search}`);
    const body = url.pathname.endsWith("checkpoint") ? { cursor: "3" } : calls.length === 2 ? { status: "valid", cursor: "4", events: [{ sequence: "4" }] } : { status: "expired", cursor: "4", retentionFloor: "5" };
    return Response.json(body);
  };
  console.log = (...args) => { output.push(...args); };
  try {
    const program = new Command(); registerEvents(program);
    await assert.rejects(program.parseAsync(["node", "tw", "events", "watch", "--project", "project", "--consumer", "worker", "--interval", "1"]), /expired/);
    assert.deepEqual(calls, ["GET /api/v1/events/checkpoint?projectId=project&consumer=worker", "GET /api/v1/events?projectId=project&cursor=3&limit=100", "GET /api/v1/events?projectId=project&cursor=4&limit=100"]);
    assert.equal(output.length, 2);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; process.env = old; }
});
