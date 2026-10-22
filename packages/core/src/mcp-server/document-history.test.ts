import test from "node:test";
import assert from "node:assert/strict";
import { boundedDocumentChunk } from "./document-history";

test("historical chunks budget JSON escapes and preserve Unicode continuation offsets", () => {
  const original = Array.from("\u0000😀文".repeat(4000));
  const offset = 137;
  const content = original.slice(offset, offset + 8000).join("");
  const result = boundedDocumentChunk({ content, totalCharacters: original.length, version: 3 }, offset);
  const returned = Array.from(result.content);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.ok(returned.length > 0 && returned.length < 8000);
  assert.equal(result.meta.nextOffset, offset + returned.length);
  assert.equal(result.content, original.slice(offset, result.meta.nextOffset!).join(""));
  assert.equal(result.content.includes("\ufffd"), false);
  assert.equal(result.meta.contentTruncated, true);
  assert.equal(boundedDocumentChunk({ content: "done", totalCharacters: 4 }, 0).meta.nextOffset, null);
});
