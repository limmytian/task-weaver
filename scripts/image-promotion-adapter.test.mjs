import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createImagePromotionAdapter } from "./image-promotion-adapter.mjs";
import { promoteImagePair } from "./image-promotion-orchestrator.mjs";

const digest = c => `sha256:${c.repeat(64)}`;
const old = { api: digest("a"), web: digest("b") }, next = { api: digest("c"), web: digest("d") };
const order = (hour, id) => ({ createdAt: `2026-10-28T0${hour}:00:00Z`, runId: String(id), attempt: 1 });

test("Git journal CAS and registry adapter promote and reject stale revisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-promotion-adapter-"));
  const priorCwd = process.cwd(), priorPath = process.env.PATH, priorDb = process.env.TW_PROMOTION_TEST_DB;
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "--bare", "remote.git"); git("init", "-q", "work");
    process.chdir(join(dir, "work"));
    const run = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    run("config", "user.name", "Fixture"); run("config", "user.email", "fixture@example.invalid");
    run("remote", "add", "origin", join(dir, "remote.git"));
    writeFileSync("journal.json", JSON.stringify({ schemaVersion: 1, committed: { version: "0.3.16", commit: "a".repeat(40), order: order(1, 1), digests: old }, pending: null }));
    run("add", "journal.json"); run("commit", "-qm", "Initialize test journal"); run("push", "-q", "origin", "HEAD:refs/heads/image-promotion-journal");
    mkdirSync(join(dir, "bin")); const registry = join(dir, "registry.json");
    writeFileSync(registry, JSON.stringify({ "api:latest": old.api, "web:latest": old.web }));
    writeFileSync(join(dir, "bin", "docker"), `#!/usr/bin/env node\nconst fs=require('fs');const p=process.env.TW_PROMOTION_TEST_DB;const db=JSON.parse(fs.readFileSync(p));const a=process.argv.slice(2);const key=x=>{const m=x.match(/-((?:api|web)):(.+)$/);return m&&m[1]+':'+m[2]};if(a[2]==='inspect'){const k=key(a[3]);if(!db[k]){console.error('manifest unknown');process.exit(1)}console.log(JSON.stringify({digest:db[k]}))}else if(a[2]==='create'){if(a[3]!=='--prefer-index=false')process.exit(3);const k=key(a[5]);db[k]=a[6].split('@')[1];fs.writeFileSync(p,JSON.stringify(db))}else process.exit(2);\n`, { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${priorPath}`; process.env.TW_PROMOTION_TEST_DB = registry;
    const adapter = createImagePromotionAdapter({ repository: "example/task-weaver" });
    const snapshot = await adapter.readJournal();
    const result = await promoteImagePair(adapter, { version: "0.3.17-main.2.1", commit: "b".repeat(40), order: order(2, 2), digests: next });
    assert.equal(result.state.pending, null); assert.deepEqual((await adapter.readPair("latest")), next);
    await assert.rejects(adapter.compareAndSwap(snapshot.revision, snapshot.state), /Journal update failed/);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8"))["api:0.3.17-main.2.1"], next.api);
  } finally {
    process.chdir(priorCwd); process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.TW_PROMOTION_TEST_DB; else process.env.TW_PROMOTION_TEST_DB = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
});
