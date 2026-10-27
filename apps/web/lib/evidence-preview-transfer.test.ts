import { test } from "node:test";
import assert from "node:assert/strict";
import { readEvidencePreview } from "./evidence-preview-transfer";

test("bounded evidence previews distinguish truncation from interrupted content", async () => {
  const sample = await readEvidencePreview(new Response("abcdef"), 6, 4);
  assert.equal(Buffer.concat(sample.parts.map(part => Buffer.from(part))).toString(), "abcd");
  assert.equal(sample.truncated, true);
  const complete = await readEvidencePreview(new Response("abc"), 3, 4);
  assert.equal(complete.truncated, false);
  await assert.rejects(readEvidencePreview(new Response("ab"), 3, 4), /interrupted/);
});
