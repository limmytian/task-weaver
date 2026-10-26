import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createResourceServices, requirementWorkspaceSchema } from "@task-weaver/core";
import { measureDatabaseWork, type Database } from "@task-weaver/db";
import type { resourcePostgresFixture } from "./resource-postgres-fixture";

/** Same disposable fixture; retain numeric evidence only, never requirement/task bodies. */
export async function checkPerformanceWorkspace(db: Database, f: Awaited<ReturnType<typeof resourcePostgresFixture>>) {
  const service = createResourceServices(f.owner.context).requirementService;
  const input = requirementWorkspaceSchema.parse({ projectId: f.project.id, completedWithinDays: 0 });
  const sample = async <T>(read: () => Promise<T>) => {
    const start = performance.now();
    const { value, measurement } = await measureDatabaseWork(read);
    return { value, receipt: { milliseconds: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(value)), database: measurement } };
  };
  const legacy = await sample(() => service.listRequirements(db, { projectId: f.project.id, completedWithinDays: 0 }));
  const first = await sample(() => service.getRequirementWorkspace(db, input));
  const expected = legacy.value.filter(row => row.status !== "archived").map(row => row.id).sort();
  const seen = first.value.items.map(row => row.id);
  for (let page = 2; page <= first.value.pageCount; page++) {
    await delay(500);
    const next = await service.getRequirementWorkspace(db, { ...input, page });
    assert.equal(next.total, expected.length); assert.equal(next.items.length, Math.min(50, expected.length - (page - 1) * 50));
    assert.deepEqual(next.summary, first.value.summary);
    seen.push(...next.items.map(row => row.id));
  }
  assert.deepEqual([...seen].sort(), expected); assert.equal(new Set(seen).size, expected.length);
  for (const row of first.value.items) {
    const oracle = legacy.value.find(item => item.id === row.id)!;
    assert.equal(row.taskCounts.total, oracle.tasks.length);
    assert.equal(row.taskCounts.done, oracle.tasks.filter(task => task.status === "done").length);
    assert.equal(row.taskCounts.inReview, oracle.tasks.filter(task => task.status === "in_review").length);
    assert.equal(row.description, oracle.description?.slice(0, 320) ?? null);
    assert.ok(!("tasks" in row));
  }
  const graph = await sample(() => service.getRequirementWorkspace(db, { ...input, graph: true }));
  assert.deepEqual(graph.value.graph!.nodes.map(row => row.id).sort(), legacy.value.map(row => row.id).sort());
  assert.deepEqual(graph.value.graph!.edges.map(row => row.id).sort(), legacy.value.flatMap(row => row.dependencies.map(dep => dep.id)).sort());
  for (const sortBy of ["created", "priority", "status", "expected"] as const) {
    const forward = await service.getRequirementWorkspace(db, { ...input, sortBy });
    const backward = await service.getRequirementWorkspace(db, { ...input, sortBy, reverse: true });
    assert.equal(forward.total, backward.total);
    assert.ok(forward.items.length <= 50 && backward.items.length <= 50);
  }
  for (const tag of first.value.tags) {
    const filtered = await service.getRequirementWorkspace(db, { ...input, tag });
    assert.equal(filtered.total, legacy.value.filter(row => row.status !== "archived" && row.tags?.includes(tag)).length);
    assert.ok(filtered.items.every(row => row.tags?.includes(tag)));
  }
  const archived = await service.getRequirementWorkspace(db, { ...input, archived: true });
  assert.equal(archived.total, legacy.value.filter(row => row.status === "archived").length);
  const clamped = await service.getRequirementWorkspace(db, { ...input, page: 99999 });
  assert.equal(clamped.page, Math.max(1, first.value.pageCount));
  await assert.rejects(() => createResourceServices(f.outsider.context).requirementService.getRequirementWorkspace(db, input));
  const viewer = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, viewer.context.actor.id, { role: "viewer" });
  await createResourceServices(viewer.context).requirementService.getRequirementWorkspace(db, input);
  await f.identity.removeMembership(f.owner.headers, f.project.id, viewer.context.actor.id);
  await assert.rejects(() => createResourceServices(viewer.context).requirementService.getRequirementWorkspace(db, input));
  return { allMatchingIdsExactlyOnce: seen.length, pages: first.value.pageCount, legacy: legacy.receipt, firstPage: first.receipt, graph: graph.receipt,
    aggregateCountsMatch: true, allGraphNodesAndEdgesPreserved: true, allFiltersBeforePagination: true,
    foreignProjectAndRevokedViewerDenied: true, clampedPageReachable: true,
    limits: "Complete compact authorized metadata still scales with requirement count; no task bodies or full descriptions materialized. Sequential correctness and first-read evidence, not saturation percentiles." };
}
