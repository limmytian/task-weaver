import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import {
  createDb, runMigrations, measureDatabaseWork, type DatabaseMeasurement,
  requirements, tasks, documents, taskDependencies, documentTaskLinks, documentRequirementLinks,
} from "@task-weaver/db";
import { createResourceServices } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { runPerformanceWave } from "./performance-workload";

const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL;
assert.ok(databaseUrl, "A disposable database is required");
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/tw_performance");
const seed = 20261026;
const timestamp = new Date("2026-10-26T00:00:00Z");
function id(kind: string, index: number) {
  const hex = createHash("sha256").update(`${seed}:${kind}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1]! : null;
};
type Operation = "taskSummary" | "requirementSummary" | "taskUpdate" | "legacyRequirements";
type Sample = { operation: Operation; milliseconds: number; bytes: number; status: number; database?: DatabaseMeasurement };
const samples: Sample[] = [];
console.log("TW_PERFORMANCE_STAGE preflight");
let measured = false;
let active = 0;
let maximumActive = 0;
// Refuse an existing database with any user relations before migrations or bootstrap resets.
const preflight = createDb(databaseUrl, { maxConnections: 1 });
try {
  const relations = await preflight.execute<{ count: string }>(sql`select count(*) as count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`);
  assert.equal(Number(relations[0]?.count), 0, "Performance fixture requires an empty database");
} finally { await preflight.$client.end({ timeout: 2 }); }
await runMigrations(databaseUrl);
console.log("TW_PERFORMANCE_STAGE fixture");
const db = createDb(databaseUrl, { maxConnections: 10, measureQueries: true });
let server: ReturnType<typeof serve> | undefined;
try {
  const fixture = await resourcePostgresFixture(db, databaseUrl);
  const owner = { id: fixture.owner.context.actor.id, type: fixture.owner.context.actor.type };
  const services = createResourceServices(fixture.owner.context);
  const other = await fixture.identity.createProject(fixture.outsider.headers, { name: "Other synthetic project" });
  const projectIds = [fixture.project.id, other.id];
  const creators = [owner.id, fixture.outsider.context.actor.id];
  const statuses = [...Array<string>(40).fill("todo"), ...Array<string>(25).fill("in_progress"), ...Array<string>(15).fill("in_review"), ...Array<string>(15).fill("done"), ...Array<string>(5).fill("cancelled")] as Array<typeof tasks.$inferInsert.status>;
  const requirementRows = Array.from({ length: 100 }, (_, i) => ({ id: id("requirement", i), projectId: projectIds[Math.floor(i / 50)]!, title: `Synthetic requirement ${i}`, description: "Synthetic requirement", status: "approved" as const, createdBy: creators[Math.floor(i / 50)]!, createdAt: timestamp, updatedAt: timestamp }));
  const taskRows = Array.from({ length: 1000 }, (_, i) => ({ id: id("task", i), projectId: projectIds[Math.floor(i / 500)]!, requirementId: id("requirement", Math.floor(i / 10)), title: `Synthetic task ${i}`, description: "Synthetic task body", status: statuses[i % 100], createdBy: creators[Math.floor(i / 500)]!, createdAt: timestamp, updatedAt: timestamp }));
  const documentRows = Array.from({ length: 100 }, (_, i) => ({ id: id("document", i), projectId: projectIds[Math.floor(i / 50)]!, title: `Synthetic document ${i}`, content: "x".repeat(4096), createdBy: creators[Math.floor(i / 50)]!, createdAt: timestamp, updatedAt: timestamp }));
  await db.insert(requirements).values(requirementRows);
  await db.insert(tasks).values(taskRows);
  await db.insert(documents).values(documentRows);
  await db.insert(taskDependencies).values(Array.from({ length: 200 }, (_, i) => ({ id: id("dependency", i), taskId: id("task", Math.floor(i / 100) * 500 + i % 100 * 2 + 1), dependsOnTaskId: id("task", Math.floor(i / 100) * 500 + i % 100 * 2), type: "related" as const })));
  await db.insert(documentTaskLinks).values(documentRows.map((d, i) => ({ id: id("document-task", i), documentId: d.id, taskId: id("task", i < 50 ? i : i + 450) })));
  await db.insert(documentRequirementLinks).values(documentRows.map((d, i) => ({ id: id("document-requirement", i), documentId: d.id, requirementId: id("requirement", i) })));
  // Setup writes deliberately bypass services only inside the newly created fixture database.
  await db.execute(sql`ANALYZE`);
  const fixtureHash = createHash("sha256").update(JSON.stringify({ seed, requirementRows: requirementRows.map(r => ({ ...r, projectId: undefined, createdBy: undefined })), taskRows: taskRows.map(r => ({ ...r, projectId: undefined, createdBy: undefined })), documentBytes: 4096, dependencies: 200, links: 200 })).digest("hex");
  const operationFor = (request: Request): Operation => request.method === "PATCH" ? "taskUpdate" : request.url.includes("/tasks?") ? "taskSummary" : request.url.includes("view=summary") ? "requirementSummary" : "legacyRequirements";
  server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const started = performance.now();
    const capture = measured;
    active++; maximumActive = Math.max(maximumActive, active);
    try {
      const { value, measurement } = await measureDatabaseWork(async () => {
        const response = await fixture.app.fetch(request);
        // Consume and reconstruct inside the request scope so serialization is included.
        const body = await response.arrayBuffer();
        return { response: new Response(body, response), bytes: body.byteLength };
      });
      if (capture) samples.push({ operation: operationFor(request), milliseconds: performance.now() - started, status: value.response.status, bytes: value.bytes, database: measurement });
      return value.response;
    } finally { active--; }
  } });
  if (!server.listening) await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const headers = fixture.owner.headers;
  const versions = new Map<string, number>();
  async function request(operation: Operation, index: number) {
    const taskId = id("task", index % 40);
    const path = operation === "taskUpdate" ? `/tasks/${taskId}` : `/projects/${fixture.project.id}/${operation === "taskSummary" ? "tasks" : "requirements"}${operation === "legacyRequirements" ? "" : "?view=summary&pageSize=20&completedWithinDays=36500"}`;
    const response = await fetch(base + path, { headers, method: operation === "taskUpdate" ? "PATCH" : "GET", signal: AbortSignal.timeout(5000), ...(operation === "taskUpdate" ? { body: JSON.stringify({ title: `Synthetic update ${index}`, expectedVersion: versions.get(taskId) ?? 1 }) } : {}) });
    const result = await response.json() as { version?: number; items?: Array<{ projectId?: string }>; total?: number };
    assert.equal(response.status, 200, "Baseline operation failed");
    if (operation === "taskUpdate") { assert.ok(result.version); versions.set(taskId, result.version); }
    if (operation === "taskSummary" || operation === "requirementSummary") {
      assert.equal(result.items?.length, 20);
      assert.equal(result.total, operation === "taskSummary" ? 500 : 50);
      assert.ok(result.items!.every(row => row.projectId === fixture.project.id));
    }
    return { operation, bytes: Number(response.headers.get("content-length") ?? 0) };
  }
  // Verify isolation before collecting successful-throughput measurements.
  console.log("TW_PERFORMANCE_STAGE isolation");
  const denied = await fetch(`${base}/projects/${other.id}/tasks?view=summary`, { headers, signal: AbortSignal.timeout(5000) });
  assert.ok([403, 404].includes(denied.status)); await denied.arrayBuffer();
  await services.taskService.getTask(db, id("task", 0));
  const coldStarted = performance.now(); await request("taskSummary", 0);
  const coldTaskSummaryMs = performance.now() - coldStarted;
  const cases = [];
  // 40/30/30 mix: progress writes are excluded until a fenced worker fixture exists.
  const mix: Operation[] = ["taskSummary", "taskSummary", "taskSummary", "taskSummary", "requirementSummary", "requirementSummary", "requirementSummary", "taskUpdate", "taskUpdate", "taskUpdate"];
  for (const concurrency of [1, 2, 4]) {
    console.log(`TW_PERFORMANCE_STAGE wave${concurrency}`);
    for (let i = 0; i < 10; i++) await request(mix[i]!, i);
    samples.length = 0; maximumActive = 0;
    const cpu = process.cpuUsage();
    measured = true;
    const { successfulDurations: clients, elapsedMs, skipped, failures } = await runPerformanceWave({ count: 300, intervalMs: 100, concurrency, request: i => request(mix[i % 10]!, i) });
    measured = false;
    assert.equal(failures, 0, "Mixed workload contained failed operations");
    const usage = process.cpuUsage(cpu);
    const memory = process.memoryUsage();
    assert.ok(memory.rss < 2.5 * 1024 ** 3 && freemem() >= 2 * 1024 ** 3, "Resource ceiling reached");
    const size = await db.execute<{ bytes: string }>(sql`select pg_database_size(current_database()) as bytes`);
    assert.ok(size[0] && Number(size[0].bytes) < 1024 ** 3, "Fixture storage ceiling reached");
    cases.push({ concurrency, offeredRps: 10, offered: 300, skipped, completed: clients.length, successfulRps: clients.length / (elapsedMs / 1000), elapsedMs, clientP95Ms: percentile(clients, .95), maximumActive, cpuMs: (usage.user + usage.system) / 1000, rssBytes: memory.rss,
      operations: mix.filter((o, i) => mix.indexOf(o) === i).map(operation => {
        const selected = samples.filter(s => s.operation === operation);
        const values = selected.map(s => s.milliseconds);
        const offered = mix.filter(value => value === operation).length * 30;
        return { operation, offered, skipped: offered - selected.length, samples: selected.length, successfulRps: selected.filter(s => s.status === 200).length / (elapsedMs / 1000), errors: selected.filter(s => s.status !== 200).length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), meanBytes: selected.reduce((sum, s) => sum + s.bytes, 0) / selected.length,
          meanQueryCount: selected.reduce((sum, s) => sum + s.database!.queryCount, 0) / selected.length,
          meanIdentityLockQueryMs: selected.reduce((sum, s) => sum + s.database!.phases.identityLock.milliseconds, 0) / selected.length,
          meanTransactionEntryMs: selected.reduce((sum, s) => sum + s.database!.phases.transactionEntry.milliseconds, 0) / selected.length,
          meanResourceTransactionMs: selected.reduce((sum, s) => sum + s.database!.phases.resourceTransaction.milliseconds, 0) / selected.length };
      }) });
  }
  samples.length = 0; measured = true; await request("legacyRequirements", 0); measured = false;
  const implementationHash = createHash("sha256");
  for (const file of ["apps/api/src/performance-baseline.ts", "apps/api/src/performance-workload.ts", "scripts/performance-baseline.mjs", "packages/db/src/measurement.ts", "packages/db/src/client.ts", "packages/core/src/services/auth-security.ts", "packages/core/src/services/resource-services.ts"]) {
    implementationHash.update(file).update(readFileSync(file));
  }
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    implementationSha256: implementationHash.digest("hex"),
  }, seed, fixtureHash,
    fixture: { projects: 2, requirements: 100, tasks: 1000, documents: 100, documentBytes: 4096, taskDependencies: 200, documentLinks: 200, progressHistory: 0 },
    runtime: { node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length, hostMemoryBytes: totalmem(), apiProcesses: 1, apiPoolMax: 10, realtimeStarted: false, transport: "loopback HTTP; API and load generator share one process" },
    coldTaskSummaryMs, cases, legacyRequirements: samples.map(({ database, ...s }) => ({ ...s, queryCount: database!.queryCount })),
    unknown: ["independent pool wait", "identity lock wait separate from lock-query execution", "per-query elapsed time and returned/scanned rows", "SQL plans", "database CPU/RSS and lock snapshots", "browser journeys", "worker/progress/console profiles", "second API process", "revoked/narrowed credentials and agent fixture", "monitoring overhead comparison", "saturation above 10 offered RPS"],
    limits: ["Small synthetic fixture only", "SQL count is ORM statements, excluding driver BEGIN/COMMIT", "Resource transaction duration includes entry, lock query and commit", "Cases run sequentially and share accumulated mutation history", "No production SLA or optimization claim", "Per-case operation samples below 200; p99 is descriptive", "No browser or model process started"] }));
} finally {
  if (server) await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); if ("closeAllConnections" in server!) server!.closeAllConnections(); });
  await db.$client.end({ timeout: 2 });
}
