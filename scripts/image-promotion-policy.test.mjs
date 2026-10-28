import assert from "node:assert/strict";
import test from "node:test";
import { comparePromotionOrder, preparePromotion, completePromotion } from "./image-promotion-policy.mjs";

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const oldPair = { api: digest("a"), web: digest("b") };
const newPair = { api: digest("c"), web: digest("d") };
const oldOrder = { createdAt: "2026-10-28T01:00:00Z", runId: "123", attempt: 1 };
const newOrder = { createdAt: "2026-10-28T02:00:00Z", runId: "124", attempt: 1 };
const baseline = () => ({ schemaVersion: 1, committed: { version: "0.3.16", commit: "a".repeat(40), order: oldOrder, digests: oldPair }, pending: null });
const candidate = () => ({ version: "0.3.17-main.124.1", commit: "b".repeat(40), order: newOrder, digests: newPair });

test("out-of-order and ambiguous publications cannot prepare", () => {
  assert.ok(comparePromotionOrder({ ...oldOrder, runId: "90071992547409930" }, { ...oldOrder, runId: "90071992547409931" }) < 0);
  assert.throws(() => preparePromotion(baseline(), { ...candidate(), order: oldOrder }, oldPair));
  assert.throws(() => preparePromotion(baseline(), candidate(), { api: oldPair.api, web: newPair.web }));
  assert.throws(() => preparePromotion({ ...baseline(), pending: {} }, candidate(), oldPair));
  assert.throws(() => preparePromotion({ ...baseline(), committed: null }, candidate(), oldPair));
  assert.throws(() => preparePromotion(baseline(), { ...candidate(), order: { ...newOrder, createdAt: "2026-02-30T00:00:00Z" } }, oldPair));
});

test("only a fully verified pair completes the prepared journal", () => {
  const prepared = preparePromotion(baseline(), candidate(), oldPair);
  assert.throws(() => completePromotion(prepared, { version: newPair, latest: { api: newPair.api, web: oldPair.web } }));
  assert.throws(() => completePromotion(prepared, { version: oldPair, latest: newPair }));
  assert.equal(prepared.pending.version, candidate().version);
  const completed = completePromotion(prepared, { version: newPair, latest: newPair });
  assert.equal(completed.pending, null);
  assert.deepEqual(completed.committed.digests, newPair);
});
