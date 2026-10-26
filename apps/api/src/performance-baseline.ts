import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { inArray, sql } from "drizzle-orm";
import {
  createDb, runMigrations, measureDatabaseWork, type DatabaseMeasurement,
  requirements, tasks, documents, taskDependencies, documentTaskLinks, documentRequirementLinks, activityLog, webhookEvents,
} from "@task-weaver/db";
import { createResourceServices } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { runPerformanceWave } from "./performance-workload";
import { readPerformanceJson, verifyPerformancePagination } from "./performance-pagination";
import { measurePerformanceQueryPlans } from "./performance-query-plans";
import { PERFORMANCE_SEED as seed, performanceId as id, performanceFixture, performanceBatches, type PerformanceTier } from "./performance-fixture";

const tierInput = process.env.TW_PERFORMANCE_TIER ?? "small";
assert.ok(tierInput === "small" || tierInput === "medium", "Unsupported performance tier");
const tier: PerformanceTier = tierInput;
const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL;
assert.ok(databaseUrl, "A disposable database is required");
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/tw_performance");
function sourceProvenance() {
  const implementationHash = createHash("sha256");
  for (const file of ["apps/api/src/performance-baseline.ts", "apps/api/src/performance-workload.ts", "apps/api/src/performance-fixture.ts", "apps/api/src/performance-pagination.ts", "apps/api/src/performance-query-plans.ts", "apps/api/src/resource-postgres-fixture.ts", "scripts/performance-baseline.mjs", "scripts/performance-local-postgres.mjs", "scripts/performance-resources.mjs", "packages/db/src/measurement.ts", "packages/db/src/client.ts", "packages/core/src/services/auth-security.ts", "packages/core/src/services/resource-services.ts"]) {
    implementationHash.update(file).update(readFileSync(file));
  }
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    implementationSha256: implementationHash.digest("hex"),
  };
}
const completedCases: Array<{ concurrency: number; offeredRps: number; repetition: number; [key: string]: unknown }> = [];
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
let monitorDb: ReturnType<typeof createDb> | undefined;
let lockMonitor: ReturnType<typeof setInterval> | undefined;
try {
  const fixture = await resourcePostgresFixture(db, databaseUrl);
  const owner = { id: fixture.owner.context.actor.id, type: fixture.owner.context.actor.type };
  const services = createResourceServices(fixture.owner.context);
  const other = await fixture.identity.createProject(fixture.outsider.headers, { name: "Other synthetic project" });
  const projectIds: [string, string] = [fixture.project.id, other.id];
  const generated = performanceFixture(projectIds, [owner.id, fixture.outsider.context.actor.id], tier);
  const { requirementRows, taskRows, documentRows, hash: fixtureHash } = generated;
  for (const batch of performanceBatches(requirementRows)) await db.insert(requirements).values(batch);
  for (const batch of performanceBatches(taskRows)) await db.insert(tasks).values(batch);
  await db.insert(documents).values(documentRows);
  for (const batch of performanceBatches(generated.dependencies)) await db.insert(taskDependencies).values(batch);
  await db.insert(documentTaskLinks).values(generated.taskLinks);
  await db.insert(documentRequirementLinks).values(generated.requirementLinks);
  // Setup and reset writes bypass services only inside the preflight-verified disposable database.
  async function resetCase() {
    await db.transaction(async tx => {
      await tx.insert(tasks).values(taskRows.slice(0, 40)).onConflictDoUpdate({ target: tasks.id,
        set: { title: sql`excluded.title`, version: 1, updatedAt: sql`excluded.updated_at` } });
      await tx.update(requirements).set({ planRevision: 0, evidenceNeedsReview: false })
        .where(inArray(requirements.id, requirementRows.map(row => row.id)));
      await tx.delete(activityLog).where(inArray(activityLog.entityId, taskRows.map(row => row.id)));
      await tx.delete(webhookEvents).where(inArray(webhookEvents.projectId, projectIds));
    });
    versions.clear();
    await db.execute(sql`ANALYZE`);
  }
  await db.execute(sql`ANALYZE`);
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
  const member = await fixture.createHuman(), viewer = await fixture.createHuman();
  await fixture.identity.setMembership(headers, fixture.project.id, member.context.actor.id, { role: "member" });
  await fixture.identity.setMembership(headers, fixture.project.id, viewer.context.actor.id, { role: "viewer" });
  const agent = await fixture.identity.createAgent(headers, { displayName: "Synthetic baseline agent" });
  await fixture.identity.setMembership(headers, fixture.project.id, agent.id, { role: "member" });
  const readGrant = { scope: "project", projectId: fixture.project.id, permissions: ["resource.read"] };
  const writeGrant = { ...readGrant, permissions: ["resource.read", "resource.write"] };
  const agentKey = await fixture.identity.issueKey(headers, agent.id, { name: "Synthetic baseline agent", grants: [writeGrant], expiresAt: null });
  const narrowedKey = await fixture.identity.issueKey(headers, owner.id, { name: "Synthetic narrowed credential", grants: [writeGrant], expiresAt: null });
  const revokedKey = await fixture.identity.issueKey(headers, owner.id, { name: "Synthetic revoked credential", grants: [readGrant], expiresAt: null });
  const bearer = (rawKey: string) => new Headers({ authorization: `Bearer ${rawKey}`, "content-type": "application/json" });
  const agentHeaders = bearer(agentKey.rawKey), narrowHeaders = bearer(narrowedKey.rawKey);
  const readIdentities = [headers, member.headers, viewer.headers, agentHeaders, narrowHeaders];
  const writeIdentities = [headers, member.headers, agentHeaders];
  const versions = new Map<string, number>();
  async function request(operation: Operation, index: number) {
    const taskId = id("task", index % 40);
    const total = operation === "taskSummary" ? generated.counts.tasks / 2 : generated.counts.requirements / 2;
    const pageCount = Math.ceil(total / 20);
    const page = tier === "medium" ? [1, Math.ceil(pageCount / 2), pageCount][index % 3]! : 1;
    const path = operation === "taskUpdate" ? `/tasks/${taskId}` : `/projects/${fixture.project.id}/${operation === "taskSummary" ? "tasks" : "requirements"}${operation === "legacyRequirements" ? "" : `?view=summary&page=${page}&pageSize=20&completedWithinDays=36500`}`;
    const selectedIdentity = operation === "taskUpdate" ? writeIdentities[index % writeIdentities.length]! : readIdentities[index % readIdentities.length]!;
    const response = await fetch(base + path, { headers: selectedIdentity, method: operation === "taskUpdate" ? "PATCH" : "GET", signal: AbortSignal.timeout(5000), ...(operation === "taskUpdate" ? { body: JSON.stringify({ title: `Synthetic update ${index}`, expectedVersion: versions.get(taskId) ?? 1 }) } : {}) });
    const { value, bytes } = await readPerformanceJson(response);
    const result = value as { version?: number; items?: Array<{ projectId?: string }>; total?: number };
    assert.equal(response.status, 200, "Baseline operation failed");
    if (operation === "taskUpdate") { assert.ok(result.version); versions.set(taskId, result.version); }
    if (operation === "taskSummary" || operation === "requirementSummary") {
      assert.equal(result.items?.length, Math.min(20, total - (page - 1) * 20));
      assert.equal(result.total, total);
      assert.ok(result.items!.every(row => row.projectId === fixture.project.id));
    }
    return { operation, bytes };
  }
  // Verify isolation before collecting successful-throughput measurements.
  console.log("TW_PERFORMANCE_STAGE isolation");
  const denied = await fetch(`${base}/projects/${other.id}/tasks?view=summary`, { headers, signal: AbortSignal.timeout(5000) });
  assert.ok([403, 404].includes(denied.status)); await denied.arrayBuffer();
  async function probe(subject: Headers, expected: number[], mutate = false) {
    const response = await fetch(`${base}/tasks/${id("task", 0)}`, { headers: subject,
      method: mutate ? "PATCH" : "GET", signal: AbortSignal.timeout(5000),
      ...(mutate ? { body: JSON.stringify({ title: "Synthetic credential probe" }) } : {}) });
    assert.ok(expected.includes(response.status), "Credential isolation preflight failed"); await response.arrayBuffer();
  }
  await probe(viewer.headers, [200]); await probe(viewer.headers, [403, 404], true);
  await probe(member.headers, [200], true); await probe(agentHeaders, [200], true);
  await probe(narrowHeaders, [200], true);
  await fixture.identity.updateKeyGrants(headers, owner.id, narrowedKey.id, { expectedVersion: narrowedKey.grantVersion, grants: [readGrant] });
  await probe(narrowHeaders, [200]); await probe(narrowHeaders, [403, 404], true);
  await fixture.identity.revokeKey(headers, owner.id, revokedKey.id);
  await probe(bearer(revokedKey.rawKey), [401]);
  await probe(fixture.outsider.headers, [403, 404]);
  await services.taskService.getTask(db, id("task", 0));
  const coldStarted = performance.now(); await request("taskSummary", 0);
  const coldTaskSummaryMs = performance.now() - coldStarted;
  const pagination = [];
  if (tier === "medium") {
    for (const kind of ["tasks", "requirements"] as const) {
      const rows = kind === "tasks" ? taskRows : requirementRows;
      const expectedIds = rows.filter(row => row.projectId === fixture.project.id).map(row => row.id);
      const result = await verifyPerformancePagination({ expectedIds, readPage: async (page, signal) => {
        const response = await fetch(`${base}/projects/${fixture.project.id}/${kind}?view=summary&page=${page}&pageSize=20&completedWithinDays=36500`, { headers, signal });
        const bytes = await response.arrayBuffer();
        assert.equal(response.status, 200, "Pagination API probe failed");
        const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as { items: Array<{ id: string; projectId: string; [key: string]: unknown }>; total: number; pageCount: number };
        assert.ok(body.items.every(row => row.projectId === fixture.project.id), "Pagination crossed project scope");
        assert.ok(body.items.every(row => !["description", "content", "tasks", "repositories"].some(key => key in row)), "Summary projection included heavy bodies or relations");
        return { ...body, bytes: bytes.byteLength };
      } });
      pagination.push({ kind, ...result });
    }
  }
  const cases = completedCases;
  const skippedProfiles: Array<{ concurrency: number; offeredRps: number; reason: string }> = [];
  let skippedAtBaseRate = false;
  const profileSamples = new Map<string, { samples: Sample[]; elapsedMs: number }>();
  monitorDb = createDb(databaseUrl, { maxConnections: 1 });
  async function tableCounters() {
    await monitorDb!.execute(sql`select pg_stat_clear_snapshot()`);
    return await monitorDb!.execute<{ relation: string; sequentialRows: number; indexedRows: number; sequentialScans: number; indexedScans: number }>(sql`
      select relname as relation, seq_tup_read::float8 as "sequentialRows", idx_tup_fetch::float8 as "indexedRows",
        seq_scan::float8 as "sequentialScans", coalesce(idx_scan,0)::float8 as "indexedScans"
      from pg_stat_user_tables where schemaname in ('public','task_weaver')
        and relname in ('tasks','requirements','project_memberships','api_keys','auth_actors') order by relname`);
  }
  // 40/30/30 mix: progress writes are excluded until a fenced worker fixture exists.
  const mix: Operation[] = ["taskSummary", "taskSummary", "taskSummary", "taskSummary", "requirementSummary", "requirementSummary", "requirementSummary", "taskUpdate", "taskUpdate", "taskUpdate"];
  const profiles = tier === "medium"
    ? [{ concurrency: 1, offeredRps: 2, repetitions: 1, requestCount: 60 }, ...[1, 2, 4].map(concurrency => ({ concurrency, offeredRps: 10, repetitions: 3, requestCount: 300 }))]
    : [{ concurrency: 1, offeredRps: 10 }, { concurrency: 2, offeredRps: 10 }, { concurrency: 4, offeredRps: 10 }, { concurrency: 4, offeredRps: 20 }].map(profile => ({ ...profile, repetitions: 3, requestCount: 300 }));
  let smokePassed = true;
  for (const { concurrency, offeredRps, repetitions, requestCount } of profiles) {
  if (!smokePassed) { skippedProfiles.push({ concurrency, offeredRps, reason: "Low-rate smoke skipped arrivals; do not raise load" }); continue; }
  if (offeredRps === 20 && skippedAtBaseRate) {
    skippedProfiles.push({ concurrency, offeredRps, reason: "Base-rate arrivals were skipped; do not raise load" });
    continue;
  }
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    console.log(`TW_PERFORMANCE_STAGE wave${concurrency}`);
    await resetCase();
    for (let i = 0; i < 10; i++) await request(mix[i]!, i);
    await delay(1100);
    const beforeCounters = await tableCounters();
    let pendingMonitor: Promise<void> | undefined;
    let lockSamples = 0, peakLockWaiters = 0, peakActiveConnections = 0, monitorFailures = 0;
    lockMonitor = setInterval(() => {
      if (pendingMonitor) return;
      pendingMonitor = monitorDb!.execute<{ waiting: number; active: number }>(sql`
        select count(*) filter(where wait_event_type = 'Lock')::int as waiting,
          count(*) filter(where state = 'active')::int as active
        from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`)
        .then(rows => { lockSamples++; peakLockWaiters = Math.max(peakLockWaiters, rows[0]?.waiting ?? 0); peakActiveConnections = Math.max(peakActiveConnections, rows[0]?.active ?? 0); }, () => { monitorFailures++; })
        .finally(() => { pendingMonitor = undefined; });
    }, 1000);
    samples.length = 0; maximumActive = 0;
    const cpu = process.cpuUsage();
    measured = true;
    const { successfulDurations: clients, elapsedMs, skipped, lateOffers, failures } = await runPerformanceWave({ count: requestCount, intervalMs: 1000 / offeredRps, concurrency, request: i => request(mix[i % 10]!, i) });
    measured = false;
    if (offeredRps === 2 && skipped > 0) smokePassed = false;
    if (offeredRps === 10 && skipped > 0) skippedAtBaseRate = true;
    clearInterval(lockMonitor); lockMonitor = undefined; await pendingMonitor;
    assert.equal(failures, 0, "Mixed workload contained failed operations");
    const usage = process.cpuUsage(cpu);
    const memory = process.memoryUsage();
    await delay(1100);
    const afterCounters = await tableCounters();
    const tableWork = afterCounters.map(after => {
      const before = beforeCounters.find(row => row.relation === after.relation);
      assert.ok(before, "Missing baseline table counters");
      return { relation: after.relation, sequentialRows: after.sequentialRows - before.sequentialRows,
        indexedRows: after.indexedRows - before.indexedRows, sequentialScans: after.sequentialScans - before.sequentialScans,
        indexedScans: after.indexedScans - before.indexedScans };
    });
    const profileKey = `${concurrency}/${offeredRps}`;
    const aggregate = profileSamples.get(profileKey) ?? { samples: [], elapsedMs: 0 };
    aggregate.samples.push(...samples); aggregate.elapsedMs += elapsedMs; profileSamples.set(profileKey, aggregate);
    // The parent owns the selected platform's host-headroom and whole-process-tree checks.
    assert.ok(memory.rss < 2.5 * 1024 ** 3, "Resource ceiling reached");
    const size = await db.execute<{ bytes: string }>(sql`select pg_database_size(current_database()) as bytes`);
    assert.ok(size[0] && Number(size[0].bytes) < 1024 ** 3, "Fixture storage ceiling reached");
    cases.push({ concurrency, offeredRps, repetition, offered: requestCount, skipped, lateOffers, completed: clients.length, successfulRps: clients.length / (elapsedMs / 1000), elapsedMs, clientP95Ms: percentile(clients, .95), maximumActive, cpuMs: (usage.user + usage.system) / 1000, rssBytes: memory.rss,
      tableWork, lockSampling: { samples: lockSamples, peakLockWaiters, peakActiveConnections, failures: monitorFailures },
      operations: mix.filter((o, i) => mix.indexOf(o) === i).map(operation => {
        const selected = samples.filter(s => s.operation === operation);
        const values = selected.map(s => s.milliseconds);
        const offered = mix.filter(value => value === operation).length * (requestCount / mix.length);
        return { operation, offered, skipped: offered - selected.length, samples: selected.length, successfulRps: selected.filter(s => s.status === 200).length / (elapsedMs / 1000), errors: selected.filter(s => s.status !== 200).length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), meanBytes: selected.reduce((sum, s) => sum + s.bytes, 0) / selected.length,
          meanQueryCount: selected.reduce((sum, s) => sum + s.database!.queryCount, 0) / selected.length,
          meanIdentityLockQueryMs: selected.reduce((sum, s) => sum + s.database!.phases.identityLock.milliseconds, 0) / selected.length,
          meanTransactionEntryMs: selected.reduce((sum, s) => sum + s.database!.phases.transactionEntry.milliseconds, 0) / selected.length,
          meanResourceTransactionMs: selected.reduce((sum, s) => sum + s.database!.phases.resourceTransaction.milliseconds, 0) / selected.length };
      }) });
  }
  }
  samples.length = 0; measured = true;
  const compatibilityStarted = performance.now();
  let compatibilityOutcome = "completed";
  try { await request("legacyRequirements", 0); }
  catch (error) { if (tier === "small") throw error; compatibilityOutcome = "deadline_or_validation_failure"; }
  measured = false;
  const compatibilityElapsedMs = performance.now() - compatibilityStarted;
  const queryPlans = await measurePerformanceQueryPlans(db, fixture.project.id, generated.counts.tasks / 2, generated.counts.requirements / 2);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source: sourceProvenance(), seed, fixtureHash,
    fixture: { tier, projects: 2, requirements: generated.counts.requirements, tasks: generated.counts.tasks, documents: generated.counts.documents, documentBytes: 4096, taskDependencies: generated.counts.dependencies, documentLinks: 200, progressHistory: 0, identityProfile: "Reads rotate owner/member/viewer/agent/narrowed key; writes rotate owner/member/agent; revoked and outsider probes excluded from successful throughput" },
    runtime: { node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length, hostMemoryBytes: totalmem(), apiProcesses: 1, apiPoolMax: 10, monitorPoolMax: 1, realtimeStarted: false, transport: "loopback HTTP; API and load generator share one process" },
    coldTaskSummaryMs, cases, skippedProfiles, pagination, queryPlans,
    profiles: [...profileSamples.entries()].map(([profile, aggregate]) => ({ profile, elapsedMs: aggregate.elapsedMs,
      operations: [...new Set(mix)].map(operation => {
        const selected = aggregate.samples.filter(sample => sample.operation === operation);
        const timings = selected.map(sample => sample.milliseconds);
        return { operation, samples: selected.length, errors: selected.filter(sample => sample.status !== 200).length,
          p50Ms: percentile(timings, .5), p95Ms: percentile(timings, .95), p99Ms: percentile(timings, .99),
          sufficientInitialSamples: selected.length >= 200 };
      }) })),
    legacyRequirements: samples.map(({ database, ...s }) => ({ ...s, queryCount: database!.queryCount })),
    compatibilityProbe: { outcome: compatibilityOutcome, elapsedMs: compatibilityElapsedMs, deadlineMs: 5000, isolatedReadOnlyProbe: true },
    unknown: ["independent pool wait", "identity lock wait separate from lock-query execution", "per-query elapsed time and returned/scanned rows beyond representative leaf plans", "authorization and relation-pruning SQL plans", "browser journeys", "worker/progress/console profiles", "second API process", "monitoring overhead comparison", "saturation above the tested offered rate"],
    limits: ["Approved small/medium synthetic fixture only", "SQL count is ORM statements, excluding driver BEGIN/COMMIT", "Resource transaction duration includes entry, lock query and commit", "Each case resets task versions/titles/timestamps, requirement revisions and mutation/outbox history before identical warmup", "Table counters are interval aggregates with asynchronous flush, not per-query row counts", "One-second lock sampling can miss short waits", "No production SLA or optimization claim", "Repeated samples support initial tails; stable p99 is not established", "No browser or model process started"] }));
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const reason = message.startsWith("Mixed workload contained failed operations") ? "workload_error"
    : message.startsWith("Resource ceiling reached") || message.startsWith("Fixture storage ceiling") ? "resource_limit"
    : message.startsWith("Credential isolation preflight") ? "credential_isolation" : "unexpected";
  console.log(`TW_PERFORMANCE_FAILURE ${reason}`);
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ source: sourceProvenance(), seed, cases: completedCases,
    currentOperations: [...new Set(samples.map(sample => sample.operation))].map(operation => ({ operation,
      samples: samples.filter(sample => sample.operation === operation).length,
      errors: samples.filter(sample => sample.operation === operation && sample.status !== 200).length })),
    failureReason: reason }));
  throw error;
} finally {
  clearInterval(lockMonitor);
  if (server) await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); if ("closeAllConnections" in server!) server!.closeAllConnections(); });
  await db.$client.end({ timeout: 2 });
  await monitorDb?.$client.end({ timeout: 2 });
}
