import assert from "node:assert/strict";
import test from "node:test";
import { pluginManifestSchema, pluginBackendResultSchema, pluginJsonValueSchema, installPluginSchema } from "./plugins";
const manifest = { schemaVersion: 1, pluginId: "example/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: "11111111-1111-4111-8111-111111111111", version: "1.0", manifestHash: "a".repeat(64) }, permissions: ["ui.render", "backend.execute", "storage.read", "storage.write"], frontend: { entryPath: "ui/index.html" }, backend: { profileId: "approved", profileHash: "b".repeat(64), entryPath: "backend/run.js" }, methods: [{ name: "increment", access: "write" }] };

test("plugin contracts bind immutable artifacts and declared isolated surfaces", () => {
  assert.ok(pluginManifestSchema.safeParse(manifest).success);
  for (const patch of [{ version: "latest" }, { artifact: { ...manifest.artifact, version: "^1.0" } }, { backend: { ...manifest.backend, command: "host-shell" } }, { permissions: ["sql.execute"] }, { permissions: ["ui.render", "ui.render"] }, { frontend: { entryPath: "../core.html" } }, { methods: [{ name: "increment", access: "write" }, { name: "increment", access: "read" }] }]) assert.equal(pluginManifestSchema.safeParse({ ...manifest, ...patch }).success, false);
  assert.equal(installPluginSchema.safeParse({ manifest, scope: { kind: "personal", ownerId: "other" }, confirmedManifestHash: "c".repeat(64), confirmed: true, idempotencyKey: "22222222-2222-4222-8222-222222222222" }).success, false);
});

test("plugin broker results cannot select another namespace or request Core operations", () => {
  const result = { result: { counter: 2 }, storageChanges: [{ key: "counter", expectedVersion: 1, operation: "put", value: 2 }] };
  assert.ok(pluginBackendResultSchema.safeParse(result).success);
  for (const patch of [{ sql: "update core" }, { storageChanges: [{ ...result.storageChanges[0], installationId: "other" }] }, { storageChanges: [{ ...result.storageChanges[0], key: "../other/counter" }] }, { storageChanges: [result.storageChanges[0], result.storageChanges[0]] }]) assert.equal(pluginBackendResultSchema.safeParse({ ...result, ...patch }).success, false);
});

test("plugin JSON limits reject cycles, sparse expansion, accessors and oversized Unicode payloads", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let getterExecuted = false;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { getterExecuted = true; return 1; } });
  for (const value of [cyclic, new Array(100000000), accessor, new Date(), Infinity, () => {}, "😀".repeat(5000)]) assert.equal(pluginJsonValueSchema.safeParse(value).success, false);
  assert.equal(pluginBackendResultSchema.safeParse({ result: cyclic }).success, false);
  assert.equal(pluginBackendResultSchema.safeParse({ result: accessor }).success, false);
  assert.equal(getterExecuted, false);
  assert.ok(pluginJsonValueSchema.safeParse({ safe: [1, true, null, "text"] }).success);
});


test("plugin skill bindings require explicit permission, exact revisions and unique names/documents", () => {
  const binding = { name: "guidance", documentId: manifest.artifact.packageId, version: 1, contentHash: "a".repeat(64) };
  const pinned = { ...manifest, permissions: [...manifest.permissions, "skills.read"], skillBindings: [binding] };
  assert.ok(pluginManifestSchema.safeParse(pinned).success);
  for (const patch of [{ permissions: manifest.permissions }, { skillBindings: [] }, { skillBindings: [binding, binding] }, { skillBindings: [{ ...binding, version: "latest" }] }, { skillBindings: [{ ...binding, contentHash: undefined }] }, { skillBindings: [{ ...binding, personalOwnerId: binding.documentId }] }]) assert.equal(pluginManifestSchema.safeParse({ ...pinned, ...patch }).success, false);
  assert.equal(Object.hasOwn(pluginManifestSchema.parse(manifest), "skillBindings"), false, "existing manifests retain their signed canonical representation");
});
