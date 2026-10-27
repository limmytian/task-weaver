import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { measureDatabaseWork } from "@task-weaver/db";
import type { resourcePostgresFixture } from "./resource-postgres-fixture";

type Fixture = Awaited<ReturnType<typeof resourcePostgresFixture>>;
/** Bounded correctness checks on the already-created disposable medium fixture. No response bodies retained. */
export async function checkPerformanceBoard(f: Fixture, expectedIds: string[], foreignRequirementId: string) {
  const projectId = f.project.id;
  const samples: Array<Record<string, unknown>> = [];
  const request = async (path: string, headers = f.owner.headers) => {
    const started = performance.now();
    const { value, measurement } = await measureDatabaseWork(async () => {
      const response = await f.app.request(path, { headers });
      const text = await response.text();
      return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
    });
    return { ...value, milliseconds: performance.now() - started, database: measurement };
  };
  const base = `/api/v1/projects/${projectId}/board-page`;
  const seen = new Set<string>();
  const expected = new Set(expectedIds);
  const pages = Math.ceil(expected.size / 50);
  for (let page = 1; page <= pages; page++) {
    const result = await request(`${base}?page=${page}&pageSize=50`);
    if (result.status !== 200) console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ boardAuditFailed: true, step: "page_status", page, actualStatus: result.status }));
    assert.equal(result.status, 200);
    assert.equal(result.body.total, expected.size);
    assert.equal(result.body.pageCount, pages);
    assert.equal(result.body.items.length, Math.min(50, expected.size - (page - 1) * 50));
    for (const item of result.body.items) {
      assert.ok(expected.has(item.id) && !seen.has(item.id));
      seen.add(item.id);
      assert.ok(item.description === null || item.description.length <= 320);
      assert.ok(!("description" in item.requirement));
      assert.equal(item.projectId, projectId);
    }
    samples.push({ page, status: result.status, items: result.body.items.length,
      bytes: result.bytes, milliseconds: result.milliseconds, database: result.database });
    await delay(500); // At most two sequential read requests per second; no parallel arrivals.
  }
  assert.equal(seen.size, expected.size);
  const repeat = await request(`${base}?page=1`);
  assert.deepEqual(repeat.body.items.map((item: { id: string }) => item.id), [...seen].slice(0, 50));
  const foreign = await request(`${base}?requirementId=${foreignRequirementId}`);
  assert.equal(foreign.status, 200); assert.equal(foreign.body.total, 0); assert.equal(foreign.body.items.length, 0);
  for (const query of ["pageSize=51", "page=0", "page=oops", "completedWithinDays=-1"]) {
    assert.equal((await request(`${base}?${query}`)).status, 400);
  }
  assert.equal((await request(base, f.outsider.headers)).status, 404);
  const viewer = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, projectId, viewer.context.actor.id, { role: "viewer" });
  assert.equal((await request(base, viewer.headers)).status, 200);
  await f.identity.removeMembership(f.owner.headers, projectId, viewer.context.actor.id);
  assert.equal((await request(base, viewer.headers)).status, 404);
  const legacy = await request(`/api/v1/projects/${projectId}/board`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.columns.reduce((sum: number, column: { count: number }) => sum + column.count, 0), expected.size);
  return { complete: true, allMatchingIdsVisitedExactlyOnce: seen.size, pages, samples,
    repeatedPageStable: true, foreignRequirementEmpty: true, foreignProjectDenied: true,
    viewerReadAndRevocation: true, invalidBoundsRejected: true,
    legacy: { bytes: legacy.bytes, milliseconds: legacy.milliseconds, database: legacy.database },
    firstPage: { bytes: repeat.bytes, milliseconds: repeat.milliseconds, database: repeat.database },
    limits: "Sequential correctness audit,not saturation or latency percentile evidence;no SQL text/bind values or bodies retained" };
}
