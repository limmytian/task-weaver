import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createImagePromotionAdapter } from "./image-promotion-adapter.mjs";
import { promoteImagePair } from "./image-promotion-orchestrator.mjs";

const digest = c => `sha256:${c.repeat(64)}`;
const next = { api: digest("c"), web: digest("d") };

test("registry adapter promotes digests without Git or a pre-existing latest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-promotion-adapter-"));
  const priorCwd = process.cwd(), priorPath = process.env.PATH, priorDb = process.env.TW_PROMOTION_TEST_DB;
  try {
    process.chdir(dir);
    mkdirSync(join(dir, "bin")); const registry = join(dir, "registry.json");
    writeFileSync(registry, JSON.stringify({}));
    writeFileSync(join(dir, "bin", "docker"), `#!/usr/bin/env node\nconst fs=require('fs');const p=process.env.TW_PROMOTION_TEST_DB;const db=JSON.parse(fs.readFileSync(p));const a=process.argv.slice(2);const key=x=>{const m=x.match(/-((?:api|web)):(.+)$/);return m&&m[1]+':'+m[2]};if(a[2]==='inspect'){const k=key(a[3]);if(!db[k]){console.error('manifest unknown');process.exit(1)}console.log(JSON.stringify({digest:db[k]}))}else if(a[2]==='create'){if(a[3]!=='--prefer-index=false')process.exit(3);const k=key(a[5]);db[k]=a[6].split('@')[1];fs.writeFileSync(p,JSON.stringify(db))}else process.exit(2);\n`, { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${priorPath}`; process.env.TW_PROMOTION_TEST_DB = registry;
    const adapter = createImagePromotionAdapter({ repository: "example/task-weaver" });
    const result = await promoteImagePair(adapter, { version: "0.3.17-main.2.1", digests: next });
    assert.equal(result.version, "0.3.17-main.2.1"); assert.deepEqual(await adapter.readPair("latest"), next);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8"))["api:0.3.17-main.2.1"], next.api);
  } finally {
    process.chdir(priorCwd); process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.TW_PROMOTION_TEST_DB; else process.env.TW_PROMOTION_TEST_DB = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
});
