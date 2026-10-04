import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerTiAgent } from "./ti";

async function runTiCommand(args: string[], response: unknown) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const previousUrl = process.env.TW_API_URL;
  const calls: string[] = [];
  const logs: string[] = [];
  process.env.TW_API_URL = "http://tw.test";
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut() {}, writeErr() {} });
  registerTiAgent(program);
  try {
    await program.parseAsync(args, { from: "user" });
    return { calls, output: logs.join("\n") };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (previousUrl === undefined) delete process.env.TW_API_URL;
    else process.env.TW_API_URL = previousUrl;
  }
}

test("ti worker status reads the API-side worker status endpoint", async () => {
  const result = await runTiCommand(["ti", "worker", "status", "--json"], {
    enabled: true,
    running: true,
    workerId: "api:host:1",
  });
  assert.deepEqual(result.calls, ["/api/v1/ti/worker/status"]);
  assert.equal(JSON.parse(result.output).workerId, "api:host:1");
});

test("ti worker health reads the gateway health endpoint", async () => {
  const result = await runTiCommand(["ti", "worker", "health", "--json"], {
    ok: true,
    enabled: true,
    gateway: { status: "ok" },
  });
  assert.deepEqual(result.calls, ["/api/v1/ti/worker/health"]);
  assert.equal(JSON.parse(result.output).ok, true);
});
