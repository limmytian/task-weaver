import assert from "node:assert/strict";
import { preparePromotion, completePromotion } from "./image-promotion-policy.mjs";

const apps = ["api", "web"];

/**
 * The adapter must implement a durable compare-and-swap journal and registry
 * operations. A caller must hold the shared exclusive publication lock.
 * A failed or ambiguous registry write leaves the intent pending.
 */
export async function promoteImagePair(adapter, candidate) {
  const snapshot = await adapter.readJournal();
  assert.ok(snapshot?.revision, "Journal revision is unavailable");
  assert.equal(snapshot.state?.pending, null, "Pending promotion requires reconciliation");
  const latest = await adapter.readPair("latest");
  const prepared = preparePromotion(snapshot.state, candidate, latest);
  const existing = await adapter.readVersion(candidate.version);
  for (const app of apps) {
    assert.ok(existing[app] === null || existing[app] === candidate.digests[app], `Immutable ${app} tag conflicts`);
  }
  const revision = await adapter.compareAndSwap(snapshot.revision, prepared);
  assert.ok(revision, "Journal compare-and-swap failed");
  return reconcileImagePromotion(adapter, { revision, state: prepared });
}

/** Resume only the exact persisted intent. No rollback or new intent is implicit. */
export async function reconcileImagePromotion(adapter, snapshot) {
  const current = await adapter.readJournal();
  assert.equal(current?.revision, snapshot.revision, "Journal changed during promotion");
  assert.deepEqual(current.state, snapshot.state, "Journal content changed during promotion");
  const pending = current.state?.pending;
  assert.ok(pending, "No pending promotion");
  // Validate the intent and its relation to the committed pair before any write.
  const baseline = { ...current.state, pending: null };
  const expected = preparePromotion(baseline, pending, pending.previous);
  assert.deepEqual(expected.pending, pending, "Invalid pending promotion");
  const observedVersion = await adapter.readVersion(pending.version);
  const observedLatest = await adapter.readPair("latest");
  for (const app of apps) {
    assert.ok(observedVersion[app] === null || observedVersion[app] === pending.digests[app], `Immutable ${app} tag conflicts`);
    assert.ok(observedLatest[app] === pending.previous[app] || observedLatest[app] === pending.digests[app], `Unexpected ${app} latest digest`);
  }
  for (const app of apps) {
    if (observedVersion[app] === null) await adapter.writeTag(app, pending.version, pending.digests[app]);
  }
  const version = await adapter.readVersion(pending.version);
  assert.deepEqual(version, pending.digests, "Version tag verification failed");
  for (const app of apps) {
    if (observedLatest[app] !== pending.digests[app]) await adapter.writeTag(app, "latest", pending.digests[app]);
  }
  const latest = await adapter.readPair("latest");
  const verifiedVersion = await adapter.readVersion(pending.version);
  const complete = completePromotion(current.state, { version: verifiedVersion, latest });
  const committedRevision = await adapter.compareAndSwap(current.revision, complete);
  assert.ok(committedRevision, "Journal commit compare-and-swap failed; reconciliation required");
  return { revision: committedRevision, state: complete };
}
