import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkEmbeddingText,
  hashDocumentEmbeddingContent,
  planDocumentEmbedding,
  resolveEmbeddingScope,
} from "./chunking";

test("embedding chunking is deterministic and overlaps at stable boundaries", () => {
  const text = Array.from({ length: 100 }, (_, index) => `word-${index}`).join(" ");
  const first = chunkEmbeddingText(text, { chunkSize: 100, chunkOverlap: 20 });
  const second = chunkEmbeddingText(text, { chunkSize: 100, chunkOverlap: 20 });
  assert.deepEqual(first.map((chunk) => ({
    index: chunk.chunkIndex,
    content: chunk.content,
    hash: chunk.contentHash,
    start: chunk.characterStart,
    end: chunk.characterEnd,
  })), second.map((chunk) => ({
    index: chunk.chunkIndex,
    content: chunk.content,
    hash: chunk.contentHash,
    start: chunk.characterStart,
    end: chunk.characterEnd,
  })));
  assert.ok(first.length > 1);
  assert.ok(first[1]!.characterStart < first[0]!.characterEnd);
});

test("document hashes normalize equivalent line endings", () => {
  assert.equal(
    hashDocumentEmbeddingContent({ title: "Title", content: "A\r\nB" }),
    hashDocumentEmbeddingContent({ title: "Title", content: "A\nB" }),
  );
});

test("embedding scope rejects mixed ownership", () => {
  assert.deepEqual(resolveEmbeddingScope({ projectId: "project-1" }), {
    scope: "project",
    projectId: "project-1",
    personalOwnerId: null,
    personalOwnerType: null,
  });
  assert.throws(() => resolveEmbeddingScope({
    projectId: "project-1",
    personalOwnerId: "owner-1",
    personalOwnerType: "agent",
  }), /cannot mix/);
});

test("document embedding plan carries version, content hash, and scope", () => {
  const plan = planDocumentEmbedding({
    id: "doc-1",
    title: "Title",
    content: "Content",
    version: 3,
  }, { chunkSize: 100, chunkOverlap: 10 });
  assert.equal(plan.documentId, "doc-1");
  assert.equal(plan.documentVersion, 3);
  assert.equal(plan.scope.scope, "global");
  assert.equal(plan.chunks.length, 1);
});
