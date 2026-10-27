import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createDb, runMigrations, measureDatabaseWork, requirements, tasks, documents, activityLog } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { performanceFixture, performanceBatches, performanceId } from "./performance-fixture";
import { runPerformanceWave } from "./performance-workload";
import { readPerformanceJson } from "./performance-pagination";

const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
assert.equal(process.env.TW_PERFORMANCE_TIER, "medium");
const sourceHash = () => {
  const hash = createHash("sha256");
  for (const file of ["apps/api/src/performance-health.ts", "apps/api/src/performance-fixture.ts",
    "apps/api/src/performance-workload.ts", "apps/api/src/resource-postgres-fixture.ts",
    "packages/core/src/services/projects.ts", "packages/core/src/services/resource-services.ts",
    "packages/core/src/services/auth-security.ts", "scripts/performance-local-postgres.mjs"])
    hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
};
const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), implementationSha256: sourceHash() };
const db = createDb(databaseUrl, { maxConnections: 4, measureQueries: true });
const cases: unknown[] = [];
let stage = "preflight";
let maximumStorageBytes = 0;
async function checkStorage() {
  const size = await db.execute<{ bytes: string }>(sql`select pg_database_size(current_database()) as bytes`);
  const bytes = Number(size[0]?.bytes);
  assert.ok(Number.isFinite(bytes) && bytes < 1024 ** 3, "Health fixture storage ceiling reached");
  maximumStorageBytes = Math.max(maximumStorageBytes, bytes);
}
const diagnostics: { status?: number; last7Days?: number; previous7Days?: number; changedFields?: string[] } = {};
const now = new Date("2026-10-26T12:00:00Z");
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  console.log("TW_PERFORMANCE_STAGE preflight");
  const inventory = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(inventory[0]?.count, 0, "Health profile requires an empty database");
  await runMigrations(databaseUrl);
  stage = "fixture"; console.log("TW_PERFORMANCE_STAGE fixture");
  const f = await resourcePostgresFixture(db, databaseUrl);
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  const generated = performanceFixture([f.project.id, other.id], [f.owner.context.actor.id, f.outsider.context.actor.id], "medium");
  for (const batch of performanceBatches(generated.requirementRows)) await db.insert(requirements).values(batch);
  for (const batch of performanceBatches(generated.taskRows)) await db.insert(tasks).values(batch);
  await db.insert(documents).values(generated.documentRows);
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7);
  await db.update(tasks).set({ expectedAt: new Date(now.getTime() - 1), completedAt: cutoff }).where(eq(tasks.id, performanceId("task", 0)));
  await db.update(tasks).set({ expectedAt: now }).where(eq(tasks.id, performanceId("task", 1)));
  await db.update(tasks).set({ updatedAt: new Date(cutoff.getTime() - 1) }).where(eq(tasks.id, performanceId("task", 41)));
  await db.update(tasks).set({ updatedAt: cutoff }).where(eq(tasks.id, performanceId("task", 42)));
  await db.update(tasks).set({ assignee: "" }).where(eq(tasks.id, performanceId("task", 10)));
  const viewer = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, viewer.context.actor.id, { role: "viewer" });
  const key = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic health key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: null });
  const revokedKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic revoked health key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: null });
  await f.identity.revokeKey(f.owner.headers, f.owner.context.actor.id, revokedKey.id);
  const writerKey = await f.identity.issueKey(f.outsider.headers, f.outsider.context.actor.id, { name: "Synthetic health load writer",
    grants: [{ scope: "project", projectId: other.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
  await db.delete(activityLog);
  // Exact seven/fourteen-day boundaries, older events and future events preserve existing window semantics.
  const offsets = [-7, -14, -15, 1];
  for (const batch of performanceBatches(generated.taskRows.map((task, i) => ({
    id: performanceId("health-activity", i), entityType: "task" as const, entityId: task.id,
    action: "synthetic", actorId: task.createdBy, actorType: "human" as const,
    createdAt: new Date(now.getTime() + offsets[i % 4]! * 86400000),
  })))) await db.insert(activityLog).values(batch);
  await db.execute(sql`ANALYZE`);
  await checkStorage();
  mock.timers.enable({ apis: ["Date"], now });
  type Health = { projectId: string; projectName: string; activitySummary: { last7Days: number; previous7Days: number }; [key: string]: unknown };
  const samples: Array<{ ms: number; bytes: number; queries: number; transactionMs: number; lockMs: number }> = [];
  let digest: string | undefined;
  let prior: Record<string, unknown> | undefined;
  async function request(headers = f.owner.headers) {
    const started = performance.now();
    const { value, measurement } = await measureDatabaseWork(async () => {
      const response = await f.app.request(`/api/v1/projects/${f.project.id}/health`, { headers });
      diagnostics.status = response.status;
      assert.equal(response.status, 200);
      return readPerformanceJson(response);
    });
    const health = value.value as Health;
    assert.equal((health.overdueTasks as unknown[]).length, 1);
    assert.equal((health.staleTasks as unknown[]).length, 1);
    diagnostics.last7Days = health.activitySummary.last7Days;
    diagnostics.previous7Days = health.activitySummary.previous7Days;
    assert.equal(health.projectId, f.project.id);
    assert.equal(health.activitySummary.last7Days, 2500);
    assert.equal(health.activitySummary.previous7Days, 1250);
    const normalized: Record<string, unknown> = { ...health, projectId: "owner-project", projectName: "Synthetic project" };
    if (prior) diagnostics.changedFields = Object.keys(normalized).filter(key => JSON.stringify(prior![key]) !== JSON.stringify(normalized[key]));
    prior = normalized;
    const hash = createHash("sha256").update(JSON.stringify({ ...health, projectId: "owner-project", projectName: "Synthetic project" })).digest("hex");
    if (digest) assert.equal(hash, digest, "Health response changed under an unchanged fixture");
    digest = hash;
    samples.push({ ms: performance.now() - started, bytes: value.bytes, queries: measurement.queryCount,
      transactionMs: measurement.phases.resourceTransaction.milliseconds, lockMs: measurement.phases.identityLock.milliseconds });
  }
  stage = "isolation"; console.log("TW_PERFORMANCE_STAGE isolation");
  const denied = await f.app.request(`/api/v1/projects/${f.project.id}/health`, { headers: f.outsider.headers });
  assert.ok([403, 404].includes(denied.status)); await denied.arrayBuffer();
  stage = "owner"; await request(); stage = "viewer"; await request(viewer.headers);
  stage = "project-key";
  await request(new Headers({ authorization: `Bearer ${key.rawKey}` }));
  const revoked = await f.app.request(`/api/v1/projects/${f.project.id}/health`, { headers: { authorization: `Bearer ${revokedKey.rawKey}` } });
  assert.ok([401, 403].includes(revoked.status)); await revoked.arrayBuffer();
  const counters = () => db.execute<{ relation: string; sequentialRows: number; indexedRows: number; sequentialScans: number; indexedScans: number }>(sql`
    select relname as relation, seq_tup_read::float8 as "sequentialRows", idx_tup_fetch::float8 as "indexedRows",
      seq_scan::float8 as "sequentialScans", idx_scan::float8 as "indexedScans"
    from pg_stat_user_tables where relname in ('tasks','requirements','documents','activity_log') order by relname`);
  const versions = new Map<string, number>();
  const writeSamples: number[] = [];
  async function write(index: number) {
    const taskId = performanceId("task", 5000 + index % 40);
    const started = performance.now();
    const response = await f.app.request(`/api/v1/tasks/${taskId}`, { method: "PATCH",
      headers: { authorization: `Bearer ${writerKey.rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: `Synthetic update ${index}`, expectedVersion: versions.get(taskId) ?? 1 }) });
    assert.equal(response.status, 200);
    const body = (await readPerformanceJson(response)).value as { version: number };
    versions.set(taskId, body.version); writeSamples.push(performance.now() - started);
  }
  for (const [mixed, offeredRps, count] of [[false, 2, 60], [false, 10, 300], [false, 10, 300],
    [true, 2, 60], [true, 10, 300], [true, 10, 300]] as const) {
    stage = "wave4"; console.log("TW_PERFORMANCE_STAGE wave4"); samples.length = 0; writeSamples.length = 0;
    await delay(1100);
    const beforeCounters = await counters();
    const cpu = process.cpuUsage();
    const wave = await runPerformanceWave({ count: count!, intervalMs: 1000 / offeredRps!, concurrency: 4, request: index => mixed && index % 10 >= 7 ? write(index) : request() });
    const usage = process.cpuUsage(cpu);
    await delay(1100);
    const afterCounters = await counters();
    const tableWork = afterCounters.map((after, i) => ({ relation: after.relation,
      sequentialRows: after.sequentialRows - beforeCounters[i]!.sequentialRows,
      indexedRows: after.indexedRows - beforeCounters[i]!.indexedRows,
      sequentialScans: after.sequentialScans - beforeCounters[i]!.sequentialScans,
      indexedScans: after.indexedScans - beforeCounters[i]!.indexedScans }));
    cases.push({ tableWork, mixed, offeredRps, offered: wave.offered, completed: samples.length + writeSamples.length, healthSamples: samples.length, writeSamples: writeSamples.length, writeP95Ms: percentile(writeSamples, .95), skipped: wave.skipped,
      failures: wave.failures, lateOffers: wave.lateOffers, elapsedMs: wave.elapsedMs, maximumInFlight: wave.maximumInFlight,
      successfulRps: (samples.length + writeSamples.length) / (wave.elapsedMs / 1000), p50Ms: percentile(samples.map(s => s.ms), .5),
      p95Ms: percentile(samples.map(s => s.ms), .95), p99Ms: percentile(samples.map(s => s.ms), .99),
      meanBytes: samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length,
      meanQueries: samples.reduce((sum, s) => sum + s.queries, 0) / samples.length,
      meanTransactionMs: samples.reduce((sum, s) => sum + s.transactionMs, 0) / samples.length,
      meanLockQueryMs: samples.reduce((sum, s) => sum + s.lockMs, 0) / samples.length,
      cpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss });
    await checkStorage();
    assert.equal(wave.failures, 0); assert.equal(wave.skipped, 0, "Do not raise load after skipped arrivals");
  }
  stage = "empty-and-cancelled";
  await db.update(tasks).set({ status: "cancelled", completedAt: null }).where(eq(tasks.projectId, f.project.id));
  async function terminalHealth() {
    const response = await f.app.request(`/api/v1/projects/${f.project.id}/health`, { headers: f.owner.headers });
    assert.equal(response.status, 200);
    const result = (await readPerformanceJson(response)).value as { breakdown: { completionRate: number; overdueRate: number };
      overdueTasks: unknown[]; staleTasks: unknown[]; unassignedTasks: number; velocity: Array<{ completed: number }>; requirementsWithoutTasks: unknown[] };
    assert.equal(result.breakdown.completionRate, 100); assert.equal(result.breakdown.overdueRate, 100);
    assert.equal(result.overdueTasks.length, 0); assert.equal(result.staleTasks.length, 0);
    assert.equal(result.unassignedTasks, 0); assert.ok(result.velocity.every(week => week.completed === 0));
    return result;
  }
  assert.equal((await terminalHealth()).requirementsWithoutTasks.length, 0);
  await db.delete(tasks).where(eq(tasks.projectId, f.project.id));
  assert.equal((await terminalHealth()).requirementsWithoutTasks.length, 500);
  assert.equal(sourceHash(), source.implementationSha256);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source, fixture: { ...generated.counts, dependencies: 0, documentTaskLinks: 0, documentRequirementLinks: 0, activityEvents: 10000,
    maximumStorageBytes,
    baseSha256: generated.hash, edgeCases: "One overdue, one stale, exact cutoffs, empty assignee and non-done completion timestamp", activityOffsetsDays: offsets, now: now.toISOString() }, responseSha256: digest,
    correctness: { emptyTasks: true, allCancelled: true, fullUncoveredRequirements: 500 },
    isolation: { viewer: true, projectKey: true, outsiderDenied: true, revokedKeyDenied: true }, cases,
    limits: ["In-process REST handler and database; excludes browser/network costs", "Read and70/30 mixed health/other-project optimistic writes at fixed offered rates, not saturation",
      "Other-project writes share the existing global lifecycle lock while leaving the owner health oracle unchanged",
      "Existing complete alert arrays remain unbounded", "Table counters are asynchronous interval diagnostics, not exact per-query rows", "Lifecycle query includes wait/execution; transaction entry is not pure pool wait"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE unexpected");
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ source, stage, cases, diagnostics })); process.exitCode = 1;
} finally { mock.timers.reset(); await db.$client.end({ timeout: 2 }); }
