import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEmbeddingGenerationTransition,
  canTransitionEmbeddingGeneration,
  canTransitionEmbeddingJob,
  canTransitionEmbeddingProfile,
} from "./lifecycle";

test("embedding lifecycle keeps terminal generations immutable", () => {
  assert.equal(canTransitionEmbeddingGeneration("building", "active"), true);
  assert.equal(canTransitionEmbeddingGeneration("active", "retired"), true);
  assert.equal(canTransitionEmbeddingGeneration("retired", "building"), false);
  assert.throws(
    () => assertEmbeddingGenerationTransition("failed", "active"),
    /cannot transition/,
  );
});

test("profiles can be disabled without retiring their active generation", () => {
  assert.equal(canTransitionEmbeddingProfile("enabled", "disabled"), true);
  assert.equal(canTransitionEmbeddingProfile("disabled", "enabled"), true);
});

test("failed jobs can resume while terminal jobs stay terminal", () => {
  assert.equal(canTransitionEmbeddingJob("failed", "queued"), true);
  assert.equal(canTransitionEmbeddingJob("cancelled", "queued"), false);
  assert.equal(canTransitionEmbeddingJob("completed", "queued"), false);
});
