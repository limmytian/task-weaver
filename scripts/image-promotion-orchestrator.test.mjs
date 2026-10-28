import assert from "node:assert/strict";
import test from "node:test";
import { promoteImagePair, reconcileImagePromotion } from "./image-promotion-orchestrator.mjs";
const d = c => `sha256:${c.repeat(64)}`;
const old = { api: d("a"), web: d("b") }, next = { api: d("c"), web: d("d") };
const order = (hour, id) => ({ createdAt: `2026-10-28T0${hour}:00:00Z`, runId: String(id), attempt: 1 });
const initial = () => ({ schemaVersion: 1, committed: { version: "0.3.16", commit: "a".repeat(40), order: order(1, 1), digests: old }, pending: null });
const candidate = () => ({ version: "0.3.17-main.2.1", commit: "b".repeat(40), order: order(2, 2), digests: next });
function fixture() {
  let state = initial(), revision = 1, writes = 0, failAt = 0;
  const tags = { latest: { ...old } };
  return {
    tags, fail(n) { failAt = n; }, get state() { return state; }, get writes() { return writes; },
    async readJournal() { return { revision: String(revision), state: structuredClone(state) }; },
    async compareAndSwap(expected, value) { if (expected !== String(revision)) return null; state = structuredClone(value); return String(++revision); },
    async readPair(tag) { return structuredClone(tags[tag]); },
    async readVersion(tag) { return structuredClone(tags[tag] ?? { api: null, web: null }); },
    async writeTag(app, tag, digest) { writes++; tags[tag] ??= { api: null, web: null }; tags[tag][app] = digest; if (writes === failAt) throw Error("ambiguous write"); },
  };
}

test("promotes only the prepared pair and verifies all references", async () => {
  const f = fixture(); await promoteImagePair(f, candidate());
  assert.deepEqual(f.tags.latest, next); assert.deepEqual(f.tags[candidate().version], next); assert.equal(f.state.pending, null);
});

test("each partial write retains intent and can be reconciled", async () => {
  for (const n of [1, 2, 3, 4]) {
    const f = fixture(); f.fail(n); await assert.rejects(promoteImagePair(f, candidate()));
    assert.ok(f.state.pending); f.fail(0); await reconcileImagePromotion(f, await f.readJournal());
    assert.deepEqual(f.tags.latest, next); assert.equal(f.state.pending, null);
  }
});

test("conflicts, stale observations and competing CAS fail before registry mutation", async () => {
  const f = fixture(); f.tags[candidate().version] = { api: d("e"), web: null };
  await assert.rejects(promoteImagePair(f, candidate()), /conflicts/); assert.equal(f.writes, 0);
  const g = fixture(); g.tags.latest.web = d("e"); await assert.rejects(promoteImagePair(g, candidate()), /differ/); assert.equal(g.writes, 0);
  const h = fixture(); h.compareAndSwap = async () => null; await assert.rejects(promoteImagePair(h, candidate()), /compare-and-swap/); assert.equal(h.writes, 0);
});

test("unknown external changes and tampered intents prevent reconciliation", async () => {
  const f = fixture(); f.fail(1); await assert.rejects(promoteImagePair(f, candidate()));
  f.tags.latest.api = d("f"); await assert.rejects(reconcileImagePromotion(f, await f.readJournal()), /Unexpected/);
  const g = fixture(); g.fail(1); await assert.rejects(promoteImagePair(g, candidate()));
  const snapshot = await g.readJournal(); snapshot.state.pending.previous.api = d("f");
  await assert.rejects(reconcileImagePromotion(g, snapshot), /Journal content changed/);
});
