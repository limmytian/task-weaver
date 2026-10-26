import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runner = new URL("./performance-baseline.mjs", import.meta.url);
const invoke = args => spawnSync(process.execPath, args, {
  encoding: "utf8", timeout: 5000,
  // No Docker, package manager or persisted application configuration can be reached.
  env: { PATH: "/nonexistent" },
});

test("help and unsupported arguments never reach Docker or echo supplied secrets", () => {
  const help = invoke([runner.pathname, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /2 GiB free host memory/);
  const invalid = invoke([runner.pathname, "--database-url=private-value"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported baseline arguments/);
  assert.ok(!invalid.stderr.includes("private-value"));
});

test("insufficient host memory fails before Docker, with no credential diagnostics", () => {
  // Patch only this isolated child process; the production runner has no guard override.
  const code = `import os from "node:os"; import { syncBuiltinESMExports } from "node:module";
    os.freemem = () => 0; syncBuiltinESMExports(); await import(${JSON.stringify(runner.href)});`;
  const result = invoke(["--input-type=module", "-e", code]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Insufficient free host memory");
  assert.equal(result.stdout, "");
});

function simulatedLifecycle(scenario) {
  // All processes and Docker operations are replaced inside the test child. No daemon is needed.
  const code = `
    import os from "node:os";
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { syncBuiltinESMExports } from "node:module";
    let name, present = false, removals = 0, pullsPrevented = false;
    const signals = [];
    const scenario = ${JSON.stringify(scenario)};
    os.freemem = () => 4 * 1024 ** 3;
    process.kill = (pid, signal) => { signals.push(signal); return true; };
    childProcess.execFileSync = (command, args) => {
      if (command !== "docker") throw new Error("Unexpected external command");
      if (args[0] === "image") return JSON.stringify({ Id: "synthetic-image", Architecture: "arm64" });
      if (args[0] === "run") {
        name = args[args.indexOf("--name") + 1]; present = true; pullsPrevented = args.includes("--pull=never");
        if (scenario === "unknown-run-outcome") throw new Error("private database diagnostics");
        return "synthetic-container";
      }
      if (args[0] === "exec") return "ready";
      if (args[0] === "inspect") return JSON.stringify([{ NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "12345" }] } } }]);
      if (args[0] === "ps") return present ? name : "";
      if (args[0] === "rm") {
        removals++;
        if (scenario === "cleanup-retry" && removals === 1) throw new Error("private cleanup diagnostics");
        if (args.at(-1) !== name) throw new Error("Foreign container removal");
        present = false; return "removed";
      }
      throw new Error("Unexpected Docker operation");
    };
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.pid = 424242;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.write("TW_PERFORMANCE_STAGE isolation\\n");
        child.stderr.write("private worker diagnostics");
        child.stdout.end(); child.stderr.end(); child.emit("exit", 1);
      });
      return child;
    };
    syncBuiltinESMExports();
    process.on("exit", () => console.log("TW_TEST_TRACE " + JSON.stringify({ present, removals, pullsPrevented, signals })));
    await import(${JSON.stringify(runner.href)});
  `;
  const result = invoke(["--input-type=module", "-e", code]);
  const trace = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("TW_TEST_TRACE ")).slice(14));
  assert.equal(result.status, 1);
  assert.equal(trace.present, false);
  assert.equal(trace.pullsPrevented, true);
  assert.ok(!result.stderr.includes("private"));
  assert.ok(!result.stdout.includes('"cleanupVerified":true'));
  return { result, trace };
}

test("an unknown Docker run outcome still inventories and removes its own container", () => {
  const { trace } = simulatedLifecycle("unknown-run-outcome");
  assert.equal(trace.removals, 1);
});

test("failed workers cannot leave descendants alive or forward raw stderr", () => {
  const { result, trace } = simulatedLifecycle("worker-failure");
  assert.match(result.stderr, /Stopped at isolation/);
  assert.ok(trace.signals.includes("SIGTERM"));
  assert.ok(trace.signals.includes("SIGKILL"));
});

test("a failed cleanup remains retryable and cannot produce a successful receipt", () => {
  const { result, trace } = simulatedLifecycle("cleanup-retry");
  assert.equal(trace.removals, 2);
  assert.match(result.stderr, /Disposable database cleanup failed/);
});
