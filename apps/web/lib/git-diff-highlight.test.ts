import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightGitDiffLine } from "./git-diff-highlight";

test("Git syntax highlighting preserves untrusted text and bounds work", () => {
  const line = '+const markup = "<script>no</script>";';
  const spans = highlightGitDiffLine("example.ts", line);
  assert.equal(spans.map(span => span.text).join(""), line);
  assert.ok(spans.some(span => span.className));
  assert.deepEqual(highlightGitDiffLine("example.svg", line), [{ text: line, className: "" }]);
  const long = `+${"x".repeat(4096)}`;
  assert.deepEqual(highlightGitDiffLine("example.ts", long), [{ text: long, className: "" }]);
});
