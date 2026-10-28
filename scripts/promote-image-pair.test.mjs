import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
const script = resolve("scripts/promote-image-pair.mjs");
const digest = c => `sha256:${c.repeat(64)}`;

test("CLI validates GitHub run identity before moving verified tags", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-promotion-cli-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    git(root, "init", "-q", "--bare", "remote.git"); git(root, "init", "-q", "work"); const cwd = join(root, "work");
    git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid"); git(cwd, "remote", "add", "origin", join(root, "remote.git"));
    writeFileSync(join(cwd, "source"), "source"); git(cwd, "add", "source"); git(cwd, "commit", "-qm", "Source"); const commit = git(cwd, "rev-parse", "HEAD");
    const initial = { schemaVersion: 1, committed: { version: "0.3.16", commit: "a".repeat(40), order: { createdAt: "2026-10-28T01:00:00Z", runId: "1", attempt: 1 }, digests: { api: digest("a"), web: digest("b") } }, pending: null };
    writeFileSync(join(cwd, "journal.json"), JSON.stringify(initial)); git(cwd, "add", "journal.json"); git(cwd, "commit", "-qm", "Journal"); git(cwd, "push", "-q", "origin", "HEAD:refs/heads/image-promotion-journal"); git(cwd, "reset", "--hard", commit);
    const bin = join(root, "bin"); mkdirSync(bin); const registry = join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({ "api:latest": digest("a"), "web:latest": digest("b") }));
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node\nconst fs=require('fs'),p=process.env.TW_TEST_REGISTRY,db=JSON.parse(fs.readFileSync(p)),a=process.argv.slice(2);const key=x=>{const m=x.match(/-((?:api|web)):(.+)$/);return m&&m[1]+':'+m[2]};if(a[2]==='inspect'){const k=key(a[3]);if(!db[k]){console.error('manifest unknown');process.exit(1)}console.log(JSON.stringify({digest:db[k]}))}else if(a[2]==='create'){db[key(a[5])]=a[6].split('@')[1];fs.writeFileSync(p,JSON.stringify(db))}else process.exit(2);\n`, { mode: 0o755 });
    const run = { id: 123, run_attempt: 1, repository: { full_name: "example/task-weaver" }, status: "in_progress", path: ".github/workflows/release-gates.yml", event: "push", head_branch: "main", head_sha: commit, created_at: "2026-10-28T02:00:00Z" };
    const runFile = join(root, "run.json"); writeFileSync(runFile, JSON.stringify(run));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "$TW_TEST_RUN"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "example/task-weaver", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", TW_TEST_REGISTRY: registry, TW_TEST_RUN: runFile };
    const invoke = () => spawnSync(process.execPath, [script, "main", "0.3.17-dev.0", digest("c"), digest("d")], { cwd, env, encoding: "utf8" });
    writeFileSync(runFile, JSON.stringify({ ...run, head_sha: "f".repeat(40) })); assert.notEqual(invoke().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), { "api:latest": digest("a"), "web:latest": digest("b") });
    writeFileSync(runFile, JSON.stringify(run)); const result = invoke(); assert.equal(result.status, 0, result.stderr);
    const tags = JSON.parse(readFileSync(registry, "utf8")); assert.equal(tags["api:latest"], digest("c")); assert.equal(tags["web:0.3.17-dev.0-main.123.1"], digest("d"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
