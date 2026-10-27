import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { createResourceServices, boardColumnsSchema, boardColumnSchema } from "@task-weaver/core";
import { type Database, tasks, measureDatabaseWork } from "@task-weaver/db";
import type { resourcePostgresFixture } from "./resource-postgres-fixture";

type Fixture = Awaited<ReturnType<typeof resourcePostgresFixture>>;
/** Same guarded medium fixture;complete cursor traversal with numeric/body-free evidence. */
export async function checkKanbanColumns(db: Database, f: Fixture) {
  const service = createResourceServices(f.owner.context).taskService;
  const input = boardColumnsSchema.parse({ projectId: f.project.id });
  const old = await service.getKanbanBoardPage(db, f.project.id, {});
  const { value: metadata, measurement: metadataWork } = await measureDatabaseWork(() => service.getKanbanBoardColumns(db, f.project.id, input));
  if (!old.items.length) return { totalMatching: metadata.total, emptyDefaultScope: true };
  const seen = new Set<string>();
  const samples = [];
  for (const column of metadata.columns) {
    let cursor: { createdAt: string; id: string } | null = null;
    let count = 0, pages = 0;
    do {
      const parsed = boardColumnSchema.parse({ ...input, value: column.value, pageSize: 50, cursor });
      const { value: page, measurement } = await measureDatabaseWork(() => service.getKanbanBoardColumn(db, f.project.id, parsed));
      assert.ok(page.items.length <= 50);
      for (const item of page.items) {
        assert.equal(item.status, column.value); assert.equal(item.projectId, f.project.id);
        assert.ok(!seen.has(item.id)); seen.add(item.id); count++;
        assert.ok(item.description === null || item.description.length <= 320);
      }
      if (!pages) samples.push({ column: column.value, firstPageItems: page.items.length, bytes: Buffer.byteLength(JSON.stringify(page)), database: measurement });
      pages++; cursor = page.nextCursor;
      assert.ok(pages <= 150);
      await delay(500);
    } while (cursor);
    assert.equal(count, column.total);
  }
  assert.equal(seen.size, metadata.total);
  const requirementId = old.items[0]!.requirementId;
  assert.ok(requirementId);
  for (const groupBy of ["status", "priority", "assignee"] as const) {
    const scope = boardColumnsSchema.parse({ ...input, groupBy, requirementId, includeTerminal: true, completedWithinDays: 0 });
    const totals = await service.getKanbanBoardColumns(db, f.project.id, scope);
    for (const column of totals.columns) {
      const page = await service.getKanbanBoardColumn(db, f.project.id, boardColumnSchema.parse({ ...scope, value: column.value }));
      assert.equal(page.items.length, column.total); assert.equal(page.nextCursor, null);
      assert.ok(page.items.every(item => item.requirementId === requirementId));
    }
  }
  const hidden = await service.getKanbanBoardColumns(db, f.project.id, { ...input, requirementId: crypto.randomUUID() });
  assert.equal(hidden.total, 0);
  await assert.rejects(() => createResourceServices(f.outsider.context).taskService.getKanbanBoardColumns(db, f.project.id, input));
  const viewer = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, viewer.context.actor.id, { role: "viewer" });
  const viewerService = createResourceServices(viewer.context).taskService;
  const first = await viewerService.getKanbanBoardColumn(db, f.project.id, boardColumnSchema.parse({ ...input, value: "todo", pageSize: 1 }));
  await f.identity.removeMembership(f.owner.headers, f.project.id, viewer.context.actor.id);
  await assert.rejects(() => viewerService.getKanbanBoardColumn(db, f.project.id, boardColumnSchema.parse({ ...input, value: "todo", cursor: first.nextCursor })));
  // Prove sub-millisecond timestamps round-trip without duplicate/gap or offset movement after a drag.
  const ids = old.items.slice(0, 4).map(item => item.id);
  const originals = await db.query.tasks.findMany({ where: sql`${tasks.id} IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})` });
  try {
    for (let index = 0; index < ids.length; index++) await db.update(tasks).set({ status: "todo", createdAt: sql`'2010-01-01T00:00:00.123456Z'::timestamptz + ${index} * interval '1 microsecond'` }).where(eq(tasks.id, ids[index]!));
    const scoped = boardColumnSchema.parse({ ...input, value: "todo", requirementId, pageSize: 1 });
    const first = await service.getKanbanBoardColumn(db, f.project.id, scoped);
    assert.ok(first.nextCursor?.createdAt.endsWith("123456Z"));
    await db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, first.items[0]!.id));
    const second = await service.getKanbanBoardColumn(db, f.project.id, { ...scoped, cursor: first.nextCursor });
    assert.equal(second.items[0]!.id, ids[1]);
    assert.ok(!second.items.some(item => item.id === first.items[0]!.id));
    const counts = await service.getKanbanBoardColumns(db, f.project.id, { ...input, requirementId });
    assert.equal(counts.columns.find(row => row.value === "in_progress")?.total, 1);
  } finally {
    for (const row of originals) await db.update(tasks).set({ status: row.status, createdAt: row.createdAt }).where(eq(tasks.id, row.id));
  }
  return { totalMatching: metadata.total, exactlyOnceTraversal: seen.size, totals: metadata.columns,
    legacyFirst50Statuses: Object.fromEntries(metadata.columns.map(column => [column.value!, old.items.filter(item => item.status === column.value).length])),
    metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), metadataWork, samples,
    independentGroupingAndFilters: true, foreignProjectDenied: true, revokedCursorDenied: true,
    microsecondCursorAndStatusMoveNoGap: true,
    limits: "Sequential fixed-medium correctness audit,not throughput/p95;no task bodies retained" };
}
