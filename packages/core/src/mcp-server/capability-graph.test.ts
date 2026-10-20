import test from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, capabilityStableId, type CapabilityManifest, type CapabilityReference } from "@task-weaver/contracts";
import { resolveCapabilityGraph } from "./capability-graph";
import { capabilityDigest } from "../services/capability-digest";

const ref = (index: number): CapabilityReference => ({ kind: "skill_package", id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` });
const node = (index: number, dependencies: CapabilityManifest["dependencies"] = [], version = "1.0"): CapabilityManifest => ({ schemaVersion: 1, reference: ref(index), scope: { kind: "global" }, version, sha256: "a".repeat(64), executionMode: "instructions", dependencies });
const dep = (index: number, version = "1.0", required = true) => ({ reference: ref(index), version, required });

test("resolution pins dependencies in topological order and deduplicates shared nodes", async () => {
  const graph = [node(1, [dep(2), dep(3)]), node(2, [dep(3)]), node(3)];
  let reads = 0;
  const result = await resolveCapabilityGraph(ref(1), undefined, async reference => { reads++; return graph.find(item => item.reference.id === reference.id)!; });
  assert.equal(reads, 3);
  assert.deepEqual(result.nodes.map(item => item.reference.id), [ref(3).id, ref(2).id, ref(1).id]);
  assert.equal(result.root.version, "1.0");
  assert.equal(result.authorization, "recheck_each_operation");
});

test("resolution rejects cycles, conflicting versions and hidden required dependencies", async () => {
  const cyclic = [node(1, [dep(2)]), node(2, [dep(1)])];
  await assert.rejects(resolveCapabilityGraph(ref(1), undefined, async reference => cyclic.find(item => item.reference.id === reference.id)!), /cycle/);
  const conflicts = [node(1, [dep(2), dep(3)]), node(2, [dep(3, "2.0")]), node(3, [], "2.0")];
  await assert.rejects(resolveCapabilityGraph(ref(1), undefined, async reference => conflicts.find(item => item.reference.id === reference.id)!), /conflicting/);
  const load = async (reference: CapabilityReference) => { if (reference.id === ref(1).id) return node(1, [dep(2)]); throw new NotFoundError("Resource not found"); };
  await assert.rejects(resolveCapabilityGraph(ref(1), undefined, load), /Resource not found/);
});

test("unavailable optional dependencies are honest and count against the lookup budget", async () => {
  const missing = await resolveCapabilityGraph(ref(1), undefined, async reference => {
    if (reference.id === ref(1).id) return node(1, [dep(2, "1.0", false)]);
    throw new NotFoundError("Resource not found");
  });
  assert.equal(missing.unavailable.length, 1);
  assert.equal(missing.nodes.length, 1);
  let reads = 0;
  await assert.rejects(resolveCapabilityGraph(ref(1), undefined, async reference => {
    reads++;
    const index = Number(reference.id.slice(-12));
    if (index >= 100) throw new NotFoundError("Resource not found");
    return index === 1 ? node(1, Array.from({ length: 10 }, (_, i) => dep(i + 2)))
      : node(index, Array.from({ length: 10 }, (_, i) => dep(index * 100 + i, "1.0", false)));
  }), /limit/);
  assert.ok(reads <= 100);
  assert.equal(capabilityStableId(ref(1)), `tw:skill_package:${ref(1).id}`);
});

test("capability hashes ignore object key order while preserving file and dependency meaning", () => {
  assert.equal(capabilityDigest({ z: 1, a: { b: 2, a: 3 } }), capabilityDigest({ a: { a: 3, b: 2 }, z: 1 }));
  assert.notEqual(capabilityDigest([1, 2]), capabilityDigest([2, 1]));
});
