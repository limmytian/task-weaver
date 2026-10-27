import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, measureDatabaseWork, requirements, tasks, documents } from "@task-weaver/db";
import { createResourceServices, AuthorizationError } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { authorizedPerformancePlans } from "./performance-authorized-plans";
import { compareMixedControl } from "./performance-mixed-control";
import { performanceFixture, performanceBatches } from "./performance-fixture";

const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
assert.equal(process.env.TW_PERFORMANCE_TIER, "medium");
const db = createDb(databaseUrl, { maxConnections: 1, measureQueries: true });
const cases: unknown[] = [];
let stage = "preflight";
// Restore only the previous full-column projection; predicates, auth, locks and classifier are unchanged.
function fullProjection(input: any): any {
  if (!input || typeof input !== "object") return input;
  const { columns: _columns, ...result } = input;
  if (result.with) result.with = Object.fromEntries(Object.entries(result.with).map(([key, value]) => [key, value === true ? true : fullProjection(value)]));
  return result;
}
try {
  const tables = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(tables[0]?.count, 0);
  await runMigrations(databaseUrl);
  stage = "fixture"; console.log("TW_PERFORMANCE_STAGE fixture");
  const f = await resourcePostgresFixture(db, databaseUrl);
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  const generated = performanceFixture([f.project.id, other.id], [f.owner.context.actor.id, f.outsider.context.actor.id], "medium");
  for (const batch of performanceBatches(generated.requirementRows)) await db.insert(requirements).values(batch);
  for (const batch of performanceBatches(generated.taskRows)) await db.insert(tasks).values(batch);
  await db.insert(documents).values(generated.documentRows);
  await db.execute(sql`ANALYZE`);
  const service = createResourceServices(f.owner.context).daemonService;
  await assert.rejects(service.listOnlineDaemons(db), AuthorizationError);
  let legacy = false, materializedBytes = 0, captured = 0;
  const transaction = db.transaction.bind(db);
  const transactionMock = mock.method(db, "transaction", (callback: any, options: any) => transaction(async tx => {
    const read = tx.query.requirements.findMany.bind(tx.query.requirements);
    const capture = mock.method(tx.query.requirements, "findMany", async (input: any) => {
      if (!input?.with?.workflowInputs || !input?.with?.tasks) return read(input);
      const rows = await read(legacy ? fullProjection(input) : input);
      materializedBytes += Buffer.byteLength(JSON.stringify(rows)); captured++;
      return rows;
    });
    try { return await callback(tx); } finally { capture.mock.restore(); }
  }, options));
  let oracle: string | undefined;
  for (const variant of ["legacy", "candidate", "legacy", "candidate"] as const) {
    legacy = variant === "legacy";
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      materializedBytes = 0; captured = 0;
      const started = performance.now();
      const { value, measurement } = await measureDatabaseWork(() => service.listDaemonControlPlaneQueues(db));
      assert.equal(captured, 1);
      const digest = createHash("sha256").update(JSON.stringify(value.items)).digest("hex");
      oracle ??= digest; assert.equal(digest, oracle);
      assert.ok(value.items.every(item => item.projectId === f.project.id));
      samples.push({ milliseconds: performance.now() - started, materializedBytes, items: value.items.length, database: measurement });
      await delay(500);
    }
    cases.push({ variant, samples });
  }
  transactionMock.mock.restore();
  const outsider = await createResourceServices(f.outsider.context).daemonService.listDaemonControlPlaneQueues(db);
  assert.ok(outsider.items.every(item => item.projectId === other.id));
  const planProbe = authorizedPerformancePlans(db);
  const planCapture = await planProbe.capture(() => service.listDaemonControlPlaneQueues(planProbe.db));
  assert.ok(planCapture.plans.some(plan => plan.shape === "daemonQueue"));
  assert.equal(createHash("sha256").update(JSON.stringify(planCapture.value.items)).digest("hex"), oracle);
  const mixed = process.env.TW_PERFORMANCE_CONTROL_PLANS_ONLY === "true" ? undefined
    : await compareMixedControl(db, databaseUrl, f, generated.taskRows.find(row => row.projectId === other.id)!.id, oracle!);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ controlProfile: true, fixtureHash: generated.hash,
    counts: generated.counts, authorizedPlans: planCapture.plans, responseItemsSha256: oracle, cases, mixed,
    correctness: { identicalClassifications: true, privateProjectsIsolated: true, legacyFleetReadRemainsClosed: true },
    limits: ["Projection cases are sequential;optional mixed cases report offered/completed load separately", "Application materialized JSON bytes,not PostgreSQL wire bytes",
      "Legacy projection restored by bounded test interception only;no alternate public auth path", "No active daemon/provider/model process executed"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE workload_error");
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ controlProfile: true, stage, cases })); process.exitCode = 1;
} finally { mock.restoreAll(); await db.$client.end({ timeout: 2 }); }
