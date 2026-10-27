import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, measureDatabaseWork, requirements, tasks, documents, activityLog,
  taskDependencies, documentTaskLinks, documentRequirementLinks, webhookEvents } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { performanceFixture, performanceId, performanceBatches, type PerformanceTier } from "./performance-fixture";
import { authorizedPerformancePlans } from "./performance-authorized-plans";
import { runPerformanceWave } from "./performance-workload";
import { readPerformanceJson } from "./performance-pagination";

const tier = process.env.TW_PERFORMANCE_TIER as PerformanceTier;
assert.ok(tier === "small" || tier === "medium");
const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const url = new URL(databaseUrl); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
const sourceHash = () => {
  const hash = createHash("sha256");
  for (const file of ["apps/api/src/performance-indexes.ts", "apps/api/src/performance-authorized-plans.ts",
    "apps/api/src/performance-query-plans.ts", "apps/api/src/performance-fixture.ts", "apps/api/src/performance-workload.ts",
    "apps/api/src/resource-postgres-fixture.ts", "scripts/performance-local-postgres.mjs", "packages/db/src/client.ts",
    "packages/core/src/services/projects.ts", "packages/core/src/services/tasks.ts", "packages/core/src/services/requirements.ts",
    "packages/core/src/services/resource-services.ts", "packages/core/src/services/auth-security.ts"])
    hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
};
const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), implementationSha256: sourceHash() };
const raw = createDb(databaseUrl, { maxConnections: 4, measureQueries: true });
const diagnostic = authorizedPerformancePlans(raw);
const db = diagnostic.db;
const stages: unknown[] = [];
let stage = "preflight";
let maximumStorageBytes = 0;
const percentile = (xs: number[], fraction: number) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * fraction) - 1];
try {
  console.log("TW_PERFORMANCE_STAGE preflight");
  const inventory = await raw.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(inventory[0]?.count, 0, "Index experiments require an empty database");
  await runMigrations(databaseUrl);
  stage = "fixture"; console.log("TW_PERFORMANCE_STAGE fixture");
  const f = await resourcePostgresFixture(db, databaseUrl);
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  const generated = performanceFixture([f.project.id, other.id], [f.owner.context.actor.id, f.outsider.context.actor.id], tier);
  for (const rows of performanceBatches(generated.requirementRows)) await raw.insert(requirements).values(rows);
  for (const rows of performanceBatches(generated.taskRows)) await raw.insert(tasks).values(rows);
  await raw.insert(documents).values(generated.documentRows);
  for (const rows of performanceBatches(generated.dependencies)) await raw.insert(taskDependencies).values(rows);
  await raw.insert(documentTaskLinks).values(generated.taskLinks);
  await raw.insert(documentRequirementLinks).values(generated.requirementLinks);
  const versions = new Map<string, number>();
  async function reset() {
    for (const rows of performanceBatches(generated.requirementRows)) await raw.insert(requirements).values(rows)
      .onConflictDoUpdate({ target: requirements.id, set: { updatedAt: sql`excluded.updated_at`, planRevision: 0, evidenceNeedsReview: false } });
    await raw.insert(tasks).values(generated.taskRows.slice(0, 40)).onConflictDoUpdate({ target: tasks.id,
      set: { title: sql`excluded.title`, version: 1, updatedAt: sql`excluded.updated_at` } });
    await raw.delete(activityLog); await raw.delete(webhookEvents); versions.clear(); await raw.execute(sql`ANALYZE`);
  }
  type Operation = "tasks" | "requirements" | "health" | "write";
  const samples: Array<{ operation: Operation; ms: number; queries: number; bytes: number }> = [];
  async function request(operation: Operation, index: number) {
    const total = generated.counts[operation === "tasks" ? "tasks" : "requirements"] / 2;
    const pages = Math.ceil(total / 20);
    const page = [1, Math.ceil(pages / 2), pages][index % 3]!;
    const taskId = performanceId("task", index % 40);
    const path = operation === "write" ? `/tasks/${taskId}` : operation === "health" ? `/projects/${f.project.id}/health`
      : `/projects/${f.project.id}/${operation}?view=summary&page=${page}&pageSize=20&completedWithinDays=36500`;
    const started = performance.now();
    const { value, measurement } = await measureDatabaseWork(async () => {
      const response = await f.app.request(`/api/v1${path}`, { headers: f.owner.headers,
        ...(operation === "write" ? { method: "PATCH", body: JSON.stringify({ title: `Synthetic update ${index}`, expectedVersion: versions.get(taskId) ?? 1 }) } : {}) });
      assert.equal(response.status, 200, "Index experiment operation failed");
      return readPerformanceJson(response);
    });
    const result = value.value as any;
    if (operation === "write") versions.set(taskId, result.version);
    else if (operation === "health") assert.equal(result.projectId, f.project.id);
    else { assert.equal(result.total, total); assert.equal(result.items.length, Math.min(20, total - (page - 1) * 20)); assert.ok(result.items.every((r: any) => r.projectId === f.project.id)); }
    samples.push({ operation, ms: performance.now() - started, queries: measurement.queryCount, bytes: value.bytes });
    return value.value;
  }
  const denied = await f.app.request(`/api/v1/projects/${f.project.id}/health`, { headers: f.outsider.headers });
  assert.ok([403, 404].includes(denied.status)); await denied.arrayBuffer();
  let controlDigest: string | undefined;
  let indexBuildMs = 0, indexBytes = 0;
  const mix: Operation[] = ["tasks", "tasks", "tasks", "requirements", "requirements", "health", "health", "write", "write", "write"];
  for (const [stageIndex, indexed] of [false, true, false].entries()) {
    if (stageIndex === 2) { await raw.execute(sql`DROP INDEX tw_perf_task_page`); await raw.execute(sql`DROP INDEX tw_perf_requirement_page`); }
    if (indexed) {
      const started = performance.now();
      // Temporary local candidates only; no migration or production index is selected.
      await raw.execute(sql`CREATE INDEX tw_perf_task_page ON tasks (project_id, updated_at DESC)`);
      await raw.execute(sql`CREATE INDEX tw_perf_requirement_page ON requirements (project_id, updated_at DESC, id DESC)`);
      indexBuildMs = performance.now() - started;
      const size = await raw.execute<{ bytes: number }>(sql`select (pg_relation_size('tw_perf_task_page') + pg_relation_size('tw_perf_requirement_page'))::float8 as bytes`);
      indexBytes = size[0]!.bytes;
    }
    await reset();
    stage = indexed ? "candidate-plans" : "control-plans";
    const probes = [];
    const responseHashes: string[] = [];
    for (const operation of ["tasks", "requirements", "health"] as const) {
      for (const position of operation === "health" ? [0] : [0, 1, 2]) {
        const captured = await diagnostic.capture(() => request(operation, position));
        assert.ok(captured.plans.length > 0, "Actual authorized query plan was not captured");
        probes.push({ operation, position, plans: captured.plans });
        responseHashes.push(createHash("sha256").update(JSON.stringify(captured.value)).digest("hex"));
      }
    }
    const digest = createHash("sha256").update(JSON.stringify(responseHashes)).digest("hex");
    if (controlDigest) assert.equal(digest, controlDigest, "Candidate index changed complete probe results");
    controlDigest = digest;
    const cases = [];
    for (const [offeredRps, count] of [[2, 60], [10, 300]] as const) {
      stage = indexed ? "candidate-load" : "control-load"; console.log("TW_PERFORMANCE_STAGE wave4");
      await reset(); for (let i = 0; i < 10; i++) await request(mix[i]!, i);
      samples.length = 0;
      const walStart = await raw.execute<{ position: string }>(sql`select pg_current_wal_insert_lsn()::text as position`);
      const cpu = process.cpuUsage();
      const wave = await runPerformanceWave({ count, intervalMs: 1000 / offeredRps, concurrency: 4, request: i => request(mix[i % 10]!, i) });
      const usage = process.cpuUsage(cpu);
      const wal = await raw.execute<{ bytes: number }>(sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${walStart[0]!.position}::pg_lsn)::float8 as bytes`);
      const size = await raw.execute<{ bytes: number }>(sql`select pg_database_size(current_database())::float8 as bytes`);
      maximumStorageBytes = Math.max(maximumStorageBytes, size[0]!.bytes); assert.ok(maximumStorageBytes < 1024 ** 3);
      cases.push({ walBytes: wal[0]!.bytes, offeredRps, offered: count, completed: samples.length, skipped: wave.skipped, failures: wave.failures,
        maximumInFlight: wave.maximumInFlight, successfulRps: samples.length / (wave.elapsedMs / 1000),
        nodeCpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss,
        operations: (["tasks", "requirements", "health", "write"] as const).map(operation => {
          const selected = samples.filter(s => s.operation === operation);
          return { operation, samples: selected.length, p95Ms: percentile(selected.map(s => s.ms), .95),
            meanQueries: selected.reduce((n, s) => n + s.queries, 0) / selected.length,
            meanBytes: selected.reduce((n, s) => n + s.bytes, 0) / selected.length };
        }) });
      assert.equal(wave.failures, 0); assert.equal(wave.skipped, 0, "Do not increase offered load after skipped arrivals");
    }
    stages.push({ indexed, stageIndex, probes, cases });
  }
  const leftovers = await raw.execute<{ count: number }>(sql`select count(*)::int as count from pg_class where relname in ('tw_perf_task_page','tw_perf_requirement_page')`);
  assert.equal(leftovers[0]?.count, 0);
  assert.equal(sourceHash(), source.implementationSha256);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source, tier, fixture: { ...generated.counts, baseSha256: generated.hash },
    controlDigest, stages, indexBuildMs, indexBytes, maximumStorageBytes, temporaryIndexesDropped: true,
    limits: ["Actual parameterized builders explained inside the original authorized resource transaction, before their normal SELECT",
      "EXPLAIN timings are sequential single observations, not request latency percentiles", "Probe result hash contains local synthetic scope IDs and is comparable within this run only",
      "Mixed workload offered rates are bounded and not saturation", "Control/candidate/control order checks warmed-stage drift; one pass is not statistical confidence", "WAL bytes cover the full read/write/auth mix, not isolated index maintenance", "Only two local candidate indexes; no production migration selected"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE unexpected"); console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ source, tier, stage, stages })); process.exitCode = 1;
} finally { await raw.$client.end({ timeout: 2 }); }
