import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stageCli } from "./pack-cli.mjs";

test("CLI staging produces a version-aligned, executable package without development artifacts", () => {
  const root = resolve(import.meta.dirname, "..");
  const version = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8")).version;
  const temp = mkdtempSync(join(tmpdir(), "tw-cli-stage-test-"));
  try {
    assert.throws(() => stageCli(root, temp, "99.0.0"), /must match contracts/);
    const stage = stageCli(root, temp, version);
    const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.bin.tw, "./dist/index.js");
    assert.ok(readFileSync(join(stage, manifest.bin.tw), "utf8").startsWith("#!/usr/bin/env node\n"));
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      assert.ok(!range.startsWith("workspace:"), `${name} retains a workspace dependency`);
      if (name.startsWith("@task-weaver/") && version.includes("-")) assert.equal(range, version);
    }
    const inspect = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? inspect(join(dir, entry.name)) : [entry.name]);
    assert.ok(inspect(stage).every(name => !/\.test\.|\.map$/.test(name)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
