import assert from "node:assert/strict";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const apps = ["api", "web"];

function pair(value) {
  assert.ok(value && typeof value === "object", "Missing image pair");
  assert.deepEqual(Object.keys(value).sort(), apps, "Image pair must contain only API and Web");
  for (const app of apps) assert.match(value[app], digestPattern, `Invalid ${app} digest`);
  return value;
}

function order(value) {
  assert.ok(value && typeof value === "object", "Missing run order");
  assert.match(value.createdAt ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(new Date(value.createdAt).toISOString(), value.createdAt.replace("Z", ".000Z"), "Invalid run timestamp");
  assert.match(value.runId ?? "", /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 0, "Invalid run attempt");
  return value;
}

export function comparePromotionOrder(left, right) {
  order(left); order(right);
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  const a = BigInt(left.runId), b = BigInt(right.runId);
  if (a !== b) return a < b ? -1 : 1;
  return Math.sign(left.attempt - right.attempt);
}

/** Prepare only after both live latest tags match the committed journal. */
export function preparePromotion(state, candidate, observedLatest) {
  assert.equal(state?.schemaVersion, 1, "Unknown promotion journal");
  assert.equal(state.pending, null, "A previous promotion requires reconciliation");
  assert.ok(state.committed, "Promotion journal requires an explicitly verified baseline");
  pair(state.committed.digests); order(state.committed.order);
  pair(observedLatest);
  assert.deepEqual(observedLatest, state.committed.digests, "Latest tags differ from committed journal");
  assert.match(candidate?.version ?? "", versionPattern, "Invalid candidate version");
  assert.match(candidate.commit ?? "", commitPattern, "Invalid candidate commit");
  pair(candidate.digests); order(candidate.order);
  assert.ok(comparePromotionOrder(candidate.order, state.committed.order) > 0, "Candidate is not newer than committed promotion");
  return { ...state, pending: { version: candidate.version, commit: candidate.commit, order: candidate.order,
    previous: { ...state.committed.digests }, digests: { ...candidate.digests } } };
}

/** Commit only after all four registry references resolve to the prepared digests. */
export function completePromotion(state, observed) {
  assert.equal(state?.schemaVersion, 1, "Unknown promotion journal");
  const pending = state.pending;
  assert.ok(pending, "No pending promotion");
  pair(pending.previous); pair(pending.digests); order(pending.order);
  pair(observed?.version); pair(observed?.latest);
  assert.deepEqual(observed.version, pending.digests, "Version tags do not match prepared digests");
  assert.deepEqual(observed.latest, pending.digests, "Latest tags do not match prepared digests");
  return { schemaVersion: 1, committed: { version: pending.version, commit: pending.commit,
    order: pending.order, digests: { ...pending.digests } }, pending: null };
}
