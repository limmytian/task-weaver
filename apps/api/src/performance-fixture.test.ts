import assert from "node:assert/strict";
import test from "node:test";
import { performanceBatches, performanceFixture } from "./performance-fixture";

test("fixture manifest is deterministic across fresh principals and covers every relationship", () => {
  const f = performanceFixture(["project-a", "project-b"], ["actor-a", "actor-b"]);
  assert.equal(f.hash, performanceFixture(["new-a", "new-b"], ["new-owner", "new-outsider"]).hash);
  const requirements = new Map(f.requirementRows.map(row => [row.id, row]));
  const tasks = new Map(f.taskRows.map(row => [row.id, row]));
  const documents = new Map(f.documentRows.map(row => [row.id, row]));
  assert.equal(requirements.size, 100); assert.equal(tasks.size, 1000); assert.equal(documents.size, 100);
  for (const task of tasks.values()) {
    assert.equal(task.projectId, requirements.get(task.requirementId)?.projectId);
    assert.equal(task.completedAt !== null, task.status === "done");
  }
  for (const edge of f.dependencies) {
    assert.equal(tasks.get(edge.taskId)?.projectId, tasks.get(edge.dependsOnTaskId)?.projectId);
    assert.notEqual(edge.taskId, edge.dependsOnTaskId);
  }
  for (const link of f.taskLinks) assert.equal(documents.get(link.documentId)?.projectId, tasks.get(link.taskId)?.projectId);
  for (const link of f.requirementLinks) assert.equal(documents.get(link.documentId)?.projectId, requirements.get(link.requirementId)?.projectId);
  assert.equal(f.dependencies.length, 200); assert.equal(f.taskLinks.length, 100); assert.equal(f.requirementLinks.length, 100);
  assert.ok(f.documentRows.every(row => Buffer.byteLength(row.content) === 4096));
});

test("medium fixture stays scoped and can be inserted without oversized statements", () => {
  const f = performanceFixture(["a", "b"], ["owner", "outsider"], "medium");
  assert.equal(f.taskRows.length, 10_000); assert.equal(f.requirementRows.length, 1000);
  assert.equal(f.dependencies.length, 2000); assert.equal(f.documentRows.length, 100);
  const requirements = new Map(f.requirementRows.map(row => [row.id, row]));
  const tasks = new Map(f.taskRows.map(row => [row.id, row]));
  for (const task of tasks.values()) assert.equal(task.projectId, requirements.get(task.requirementId)?.projectId);
  for (const edge of f.dependencies) assert.equal(tasks.get(edge.taskId)?.projectId, tasks.get(edge.dependsOnTaskId)?.projectId);
  for (const link of f.requirementLinks) {
    const doc = f.documentRows.find(row => row.id === link.documentId)!;
    assert.equal(doc.projectId, requirements.get(link.requirementId)?.projectId);
  }
  const batches = [...performanceBatches(f.taskRows)];
  assert.equal(batches.length, 20); assert.ok(batches.every(batch => batch.length <= 500));
  assert.equal(new Set(batches.flat().map(row => row.id)).size, 10_000);
  assert.equal(f.hash, performanceFixture(["new-a", "new-b"], ["new-owner", "new-outsider"], "medium").hash);
  assert.notEqual(f.hash, performanceFixture(["a", "b"], ["owner", "outsider"]).hash);
});

test("fixture status distribution and ordering are fixed independently in each project", () => {
  const f = performanceFixture(["a", "b"], ["owner", "outsider"]);
  for (const project of ["a", "b"]) {
    const tasks = f.taskRows.filter(row => row.projectId === project);
    const counts: Record<string, number> = {};
    for (const row of tasks) counts[row.status] = (counts[row.status] ?? 0) + 1;
    assert.deepEqual(counts, { todo: 200, in_progress: 125, in_review: 75, done: 75, cancelled: 25 });
    assert.equal(new Set(tasks.map(row => row.updatedAt.getTime())).size, 500);
    assert.ok(tasks.every(row => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)));
  }
});
