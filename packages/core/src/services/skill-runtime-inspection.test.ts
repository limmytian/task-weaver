import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readonlyImageVolumes } from "./skill-runtime";

test("runtime preflight tolerates a slow engine inspection and still enforces isolation and deadlines", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tw-docker-inspection-"));
  const previousPath = process.env.PATH;
  let scenario = "slow";
  const fixture = async () => writeFile(join(directory, "docker"), `#!${process.execPath}
const scenario = ${JSON.stringify(scenario)};
if (process.argv[2] === 'info') {
  if (scenario === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => console.log(JSON.stringify({OSType:'linux',MemoryLimit:scenario !== 'unsafe',CpuCfsQuota:true,PidsLimit:true})), scenario === 'slow' ? 2000 : 0);
} else {
  if (scenario === 'unsafe') process.exit(91);
  console.log(JSON.stringify({'/declared-data':{}}));
}
`, { mode: 0o755 });
  try {
    process.env.PATH = directory;
    await fixture();
    assert.deepEqual(await readonlyImageVolumes("fixture/runtime@sha256:" + "a".repeat(64), false), ["--tmpfs=/declared-data:ro,noexec,nosuid,size=1m"]);
    scenario = "unsafe"; await fixture();
    await assert.rejects(readonlyImageVolumes("fixture/runtime", false), /enforced memory, CPU and process limits/);
    scenario = "hang"; await fixture();
    const started = Date.now();
    await assert.rejects(readonlyImageVolumes("fixture/runtime", false));
    assert.ok(Date.now() - started < 10_000, "Unresponsive engines must remain bounded");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
