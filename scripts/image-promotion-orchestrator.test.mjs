import assert from "node:assert/strict";
import test from "node:test";
import { promoteImagePair } from "./image-promotion-orchestrator.mjs";
const d = c => `sha256:${c.repeat(64)}`;
const old = { api: d("a"), web: d("b") }, next = { api: d("c"), web: d("d") };
const candidate = () => ({ version: "0.3.17-main.2.1", digests: next });
function fixture() {
  let writes = 0, failAt = 0;
  const tags = { latest: { ...old } };
  return {
    tags, fail(n) { failAt = n; }, get writes() { return writes; },
    async readPair(tag) { return structuredClone(tags[tag]); },
    async readVersion(tag) { return structuredClone(tags[tag] ?? { api: null, web: null }); },
    async writeTag(app, tag, digest) { writes++; tags[tag] ??= { api: null, web: null }; tags[tag][app] = digest; if (writes === failAt) throw Error("ambiguous write"); },
  };
}

test("promotes the verified pair and skips unchanged tags on retry", async () => {
  const f = fixture(); const result = await promoteImagePair(f, candidate());
  assert.deepEqual(result, candidate());
  assert.deepEqual(f.tags.latest, next); assert.deepEqual(f.tags[candidate().version], next);
  const writes = f.writes; await promoteImagePair(f, candidate()); assert.equal(f.writes, writes);
});

test("every ambiguous partial write can be retried with the same digests", async () => {
  for (const n of [1, 2, 3, 4]) {
    const f = fixture(); f.fail(n); await assert.rejects(promoteImagePair(f, candidate()), /ambiguous write/);
    f.fail(0); await promoteImagePair(f, candidate());
    assert.deepEqual(f.tags.latest, next); assert.deepEqual(f.tags[candidate().version], next);
  }
});

test("either immutable version conflict prevents all registry writes", async () => {
  for (const app of ["api", "web"]) {
    const f = fixture(); f.tags[candidate().version] = { api: null, web: null, [app]: d("e") };
    await assert.rejects(promoteImagePair(f, candidate()), /conflicts/); assert.equal(f.writes, 0);
  }
});

test("version verification failure leaves latest unchanged", async () => {
  const f = fixture(); f.readPair = async () => ({ api: d("e"), web: next.web });
  await assert.rejects(promoteImagePair(f, candidate()), /Version tag verification failed/);
  assert.deepEqual(f.tags.latest, old); assert.equal(f.writes, 2);
});

test("latest verification detects a lost or competing write", async () => {
  const f = fixture(); const read = f.readPair;
  f.readPair = async tag => tag === "latest" ? old : read(tag);
  await assert.rejects(promoteImagePair(f, candidate()), /Latest tag verification failed/);
});

test("first publication works without previous latest tags", async () => {
  const f = fixture(); delete f.tags.latest;
  await promoteImagePair(f, candidate()); assert.deepEqual(f.tags.latest, next);
});

test("invalid versions and digests fail before registry writes", async () => {
  for (const patch of [{ version: "latest" }, { version: "../bad" }, { digests: { api: "bad", web: next.web } }]) {
    const f = fixture(); await assert.rejects(promoteImagePair(f, { ...candidate(), ...patch })); assert.equal(f.writes, 0);
  }
});
