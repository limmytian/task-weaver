import { strict as assert } from "node:assert";
import { test } from "node:test";
import { REVIEW_SUMMARY_PREVIEW_LIMIT, reviewTextPreview } from "./review-summary";

test("review text stays intact below the preview limit", () => {
  const value = "A useful result";
  assert.deepEqual(reviewTextPreview(value, false), { text: value, truncated: false, remainingCharacters: 0 });
});

test("review text reports the omitted length and restores full content on expansion", () => {
  const value = "x".repeat(REVIEW_SUMMARY_PREVIEW_LIMIT + 17);
  assert.deepEqual(reviewTextPreview(value, false), {
    text: "x".repeat(REVIEW_SUMMARY_PREVIEW_LIMIT), truncated: true, remainingCharacters: 17,
  });
  assert.deepEqual(reviewTextPreview(value, true), { text: value, truncated: true, remainingCharacters: 17 });
});
