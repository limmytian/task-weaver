import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStableId, capabilityManifestSchema, discoverCapabilitiesSchema, capabilityAvailabilitySchema } from "./capabilities";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const manifest = { schemaVersion: 1, reference: { kind: "skill_package", id }, scope: { kind: "global" }, version: "1.0", sha256: "a".repeat(64), executionMode: "instructions" };

test("capability references separate kinds and reject ownership or scope escalation", () => {
  assert.notEqual(capabilityStableId({ kind: "memory", id }), capabilityStableId({ kind: "skill", id }));
  for (const scope of [{ kind: "personal", personalOwnerId: id }, { kind: "global", projectId: id }, { kind: "project" }]) {
    assert.equal(discoverCapabilitiesSchema.safeParse({ intent: "test", scope }).success, false);
  }
  assert.equal(discoverCapabilitiesSchema.safeParse({ intent: "test", scope: { kind: "personal" }, actorId: id }).success, false);
  assert.equal(discoverCapabilitiesSchema.safeParse({ intent: "test", scope: { kind: "global" }, limit: 21 }).success, false);
  assert.equal(discoverCapabilitiesSchema.safeParse({ intent: "test", scope: { kind: "global" }, kinds: ["memory", "memory"] }).success, false);
});

test("execution manifests reject self, duplicate, floating and unbounded dependencies", () => {
  const dependency = { reference: { kind: "skill_package", id: other }, version: "2.0" };
  assert.equal(capabilityManifestSchema.safeParse({ ...manifest, dependencies: [dependency] }).success, true);
  for (const dependencies of [
    [{ reference: manifest.reference, version: "1.0" }],
    [dependency, dependency],
    [{ reference: dependency.reference }],
    Array.from({ length: 33 }, () => dependency),
  ]) assert.equal(capabilityManifestSchema.safeParse({ ...manifest, dependencies }).success, false);
  assert.equal(capabilityManifestSchema.safeParse({ ...manifest, entryPath: "../secret" }).success, false);
  assert.equal(capabilityManifestSchema.safeParse({ ...manifest, command: "arbitrary-process" }).success, false);
  for (const version of ["latest", "*", "^1.0", ">=1.0", "1.0 || 2.0"]) {
    assert.equal(capabilityManifestSchema.safeParse({ ...manifest, dependencies: [{ ...dependency, version }] }).success, false);
  }
});

test("availability requires an actual execution mode or an actionable unavailable reason", () => {
  assert.equal(capabilityAvailabilitySchema.safeParse({ state: "available", executionMode: "instructions" }).success, true);
  assert.equal(capabilityAvailabilitySchema.safeParse({ state: "available" }).success, false);
  assert.equal(capabilityAvailabilitySchema.safeParse({ state: "unavailable", reason: "local_bridge_required" }).success, false);
});
