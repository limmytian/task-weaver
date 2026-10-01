import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/check-ce-artifact-compatibility.mjs");
const names = ["contracts", "db", "realtime", "core", "partners-gateway"];

function makeArtifacts(root, version, sql) {
  const directory = join(root, version);
  mkdirSync(directory);
  writeFileSync(join(directory, "npm-artifacts.json"), JSON.stringify({ version }));
  for (const name of names) {
    const stage = join(directory, `stage-${name}`);
    const packageRoot = join(stage, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: `@task-weaver/${name}`, version, exports: { ".": "./index.js" } }));
    if (name === "db") {
      mkdirSync(join(packageRoot, "drizzle/meta"), { recursive: true });
      writeFileSync(join(packageRoot, "drizzle/meta/_journal.json"), JSON.stringify({ entries: [{ idx: 0, tag: "0000_initial" }] }));
      writeFileSync(join(packageRoot, "drizzle/0000_initial.sql"), sql);
    }
    execFileSync("tar", ["-czf", join(directory, `task-weaver-${name}-${version}.tgz`), "-C", stage, "package"]);
  }
  return directory;
}

test("release comparison accepts additive packages and rejects historical SQL changes", () => {
  const root = mkdtempSync(join(tmpdir(), "ce-artifact-compatibility-"));
  try {
    const previous = makeArtifacts(root, "0.2.0", "SELECT 1;\n");
    const next = makeArtifacts(root, "0.2.1", "SELECT 1;\n");
    const accepted = spawnSync(process.execPath, [script, previous, next], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(readFileSync(join(next, "compatibility.json"), "utf8")).previousMigrations, 1);

    const changed = makeArtifacts(root, "0.2.2", "SELECT 2;\n");
    const rejected = spawnSync(process.execPath, [script, previous, changed], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Core migration file changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function changeExports(directory, name, version, exports) {
  const stage = join(directory, `stage-${name}`);
  writeFileSync(join(stage, "package/package.json"), JSON.stringify({ name: `@task-weaver/${name}`, version, exports }));
  execFileSync("tar", ["-czf", join(directory, `task-weaver-${name}-${version}.tgz`), "-C", stage, "package"]);
}

test("0.3 transition permits only named retired exports and preserves SQL", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-retired-exports-"));
  try {
    const previous = makeArtifacts(root, "0.2.1", "SELECT 1;\n");
    const next = makeArtifacts(root, "0.3.0", "SELECT 1;\n");
    changeExports(previous, "core", "0.2.1", { ".": "./index.js", "./default-ports": "./ports.js" });
    changeExports(previous, "partners-gateway", "0.2.1", { ".": "./index.js", "./module": "./module.js" });
    const accepted = spawnSync(process.execPath, [script, previous, next], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(readFileSync(join(next, "compatibility.json"), "utf8")).breakingExports.length, 2);
    changeExports(previous, "core", "0.2.1", { ".": "./index.js", "./unexpected": "./extra.js" });
    const rejected = spawnSync(process.execPath, [script, previous, next], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /removed public export/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
