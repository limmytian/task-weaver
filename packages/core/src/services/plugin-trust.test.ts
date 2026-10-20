import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { pluginManifestSchema } from "@task-weaver/contracts";
import { pluginSigningPayload, verifyPluginManifest } from "./plugin-trust";

test("plugin publisher verification binds normalized manifest, artifact and operator publisher trust", () => {
  const key = generateKeyPairSync("ed25519");
  const manifest = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "example/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: "11111111-1111-4111-8111-111111111111", version: "1.0", manifestHash: "a".repeat(64) }, permissions: ["ui.render"], frontend: { entryPath: "ui/index.html" } });
  const signature = { algorithm: "ed25519" as const, keyId: "publisher-key", value: sign(null, Buffer.from(pluginSigningPayload(manifest)), key.privateKey).toString("base64") };
  const signed = { ...manifest, signature };
  const keys = { "publisher-key": { publisher: "example", publicKey: key.publicKey.export({ format: "pem", type: "spki" }).toString() } };
  assert.equal(verifyPluginManifest(signed, keys).trust, "verified");
  assert.throws(() => verifyPluginManifest({ ...signed, displayName: "Changed" }, keys));
  assert.throws(() => verifyPluginManifest({ ...signed, artifact: { ...manifest.artifact, manifestHash: "b".repeat(64) } }, keys));
  assert.throws(() => verifyPluginManifest(signed, {}));
  assert.throws(() => verifyPluginManifest(signed, { "publisher-key": { ...keys["publisher-key"], publisher: "other" } }));
  assert.throws(() => verifyPluginManifest(manifest, keys));
  assert.equal(verifyPluginManifest(manifest, keys, true).trust, "unverified");
  assert.throws(() => verifyPluginManifest(signed, {}, true));
});
