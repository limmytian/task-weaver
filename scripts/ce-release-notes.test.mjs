import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const generator = resolve(import.meta.dirname, "ce-release-notes.mjs");
test("release notes preserve curated upgrade warnings and translation with immutable links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tw-release-notes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["contracts", "db", "realtime", "core", "partners-gateway"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name, version: "0.3.3" }));
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "feat: fixture");
  git("tag", "v0.3.2");
  const commit = git("rev-parse", "HEAD");
  mkdirSync(join(root, "docs/releases"), { recursive: true });
  for (const suffix of ["md", "zh-CN.md"]) {
    writeFileSync(join(root, `docs/releases/0.3.3.${suffix}`),
      `# Curated upgrade\n\n[Recovery](../ce-upgrades.md#recovery)\n[External](https://example.test)\n`);
  }
  execFileSync(process.execPath, [generator, "0.3.3", "v0.3.2"], { cwd: root });
  for (const name of ["RELEASE_NOTES.md", "RELEASE_NOTES.zh-CN.md"]) {
    const text = readFileSync(join(root, "release-artifacts", name), "utf8");
    assert.match(text, /^# Curated upgrade/);
    assert.ok(text.includes(`https://github.com/limmytian/task-weaver/blob/${commit}/docs/ce-upgrades.md#recovery`));
    assert.ok(text.includes("https://example.test"));
  }
  assert.throws(() => execFileSync(process.execPath, [generator, "0.3.4", "v0.3.2"], { cwd: root, stdio: "pipe" }));
});
