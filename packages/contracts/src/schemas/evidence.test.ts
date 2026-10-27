import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceDescriptorSchema, evidenceNodeDemandSchema, evidenceNodeResultSchema, evidenceReadRequestSchema } from "./evidence";

const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
test("evidence requests and public manifests reject paths and unregistered sources", () => {
  assert.equal(evidenceReadRequestSchema.safeParse({ outputId: id, purpose: "preview", path: "../secret" }).success, false);
  assert.equal(evidenceDescriptorSchema.safeParse({ kind: "local", outputId: id, projectId: id, requirementId: id, availability: "available", nodeId: "node", sizeBytes: 1, sha256: hash, relativePath: "secret" }).success, false);
  assert.equal(evidenceDescriptorSchema.safeParse({ kind: "git", outputId: id, projectId: id, requirementId: id, availability: "available", requirementRepositoryId: id, headCommit: "main" }).success, false);
});
test("producer demand binds a bounded immutable identity and verified completion", () => {
  const demand = { requestId: id, outputId: id, projectId: id, requirementId: id, daemonId: id, nodeId: "node", nonce: hash, purpose: "preview", sizeBytes: 1, sha256: hash, expiresAt: "2026-10-27T10:00:00Z" };
  assert.equal(evidenceNodeDemandSchema.safeParse(demand).success, true);
  assert.equal(evidenceNodeDemandSchema.safeParse({ ...demand, sizeBytes: 101 * 1024 * 1024 }).success, false);
  const result = { requestId: id, daemonId: id, outputId: id, nonce: hash, sequence: 0, final: true, state: "available" };
  assert.equal(evidenceNodeResultSchema.safeParse(result).success, false);
  assert.equal(evidenceNodeResultSchema.safeParse({ ...result, verifiedSizeBytes: 1, verifiedSha256: hash }).success, true);
});
