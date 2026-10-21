import assert from "node:assert/strict";
import test from "node:test";
import { pluginManifestSchema, installPluginSchema } from "@task-weaver/contracts";
import { configuredPluginDirectory, pluginDirectoryReviewHash, verifyPluginDirectorySelection } from "./plugin-directory";
const id = "11111111-1111-4111-8111-111111111111";
const manifest = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "example/counter", version: "1.0.0", displayName: "Counter", permissions: ["backend.execute"], artifact: { packageId: id, version: "1.0", manifestHash: "a".repeat(64) }, backend: { profileId: "fixture", profileHash: "b".repeat(64), entryPath: "run.sh" } });
const entry = { id: "counter", maintainer: "Example maintainer", sourceUrl: "https://github.com/limmytian/task-weaver", sourceRevision: "a".repeat(40), reviewedAt: "2026-10-21T00:00:00.000Z", manifest };
const reviewed = { ...entry, reviewHash: pluginDirectoryReviewHash(entry) };
test("directory hashes bind normalized manifests and provenance, with explicit bounded operator configuration", () => {
  const raw = JSON.stringify([reviewed]);
  assert.equal(configuredPluginDirectory(raw)[0]!.id, "counter");
  assert.deepEqual(configuredPluginDirectory(), []);
  for (const invalid of ["not JSON", "x".repeat(524289), JSON.stringify([reviewed, reviewed]), JSON.stringify([{ ...reviewed, maintainer: "Changed" }]), JSON.stringify([{ ...reviewed, sourceUrl: "https://user:secret@example.test" }])]) assert.throws(() => configuredPluginDirectory(invalid));
  verifyPluginDirectorySelection(raw, { entryId: "counter", reviewHash: reviewed.reviewHash }, manifest);
  assert.throws(() => verifyPluginDirectorySelection("[]", { entryId: "counter", reviewHash: reviewed.reviewHash }, manifest));
  assert.throws(() => verifyPluginDirectorySelection(raw, { entryId: "counter", reviewHash: reviewed.reviewHash }, { ...manifest, version: "1.1.0" }));
  const plain = installPluginSchema.parse({ scope: { kind: "personal" }, manifest, confirmedManifestHash: "c".repeat(64), confirmed: true, idempotencyKey: id });
  assert.equal(Object.hasOwn(plain, "directory"), false, "existing install requests retain their canonical hash");
});
