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
