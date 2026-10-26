import assert from "node:assert/strict";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { createDb, runMigrations } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const url = new URL(databaseUrl); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
assert.equal(realpathSync("packages/db/node_modules/postgres"), realpathSync("packages/realtime/node_modules/postgres"));
const driverVersion = JSON.parse(readFileSync("packages/db/node_modules/postgres/package.json", "utf8")).version;
const sourceHash = () => {
  const hash = createHash("sha256");
  for (const file of ["apps/api/src/performance-connections.ts", "apps/api/src/performance-connection-child.ts",
    "apps/api/src/resource-postgres-fixture.ts", "packages/db/src/client.ts", "packages/db/src/pool-options.ts",
    "packages/realtime/src/index.ts", "packages/db/node_modules/postgres/src/index.js", "scripts/performance-local-postgres.mjs"])
    hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
};
const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), implementationSha256: sourceHash() };
const observer = createDb(databaseUrl, { maxConnections: 1 });
const gate = createDb(databaseUrl, { maxConnections: 1 });
const children: ChildProcess[] = [];
const cases: unknown[] = [];
let stage = "preflight";
let releaseGate = () => {};
let gateWork: Promise<unknown> | undefined;
function endpoint(child: ChildProcess) {
  const inbox: any[] = [], waiting: Array<{ type: string; resolve(value: any): void; reject(error: Error): void }> = [];
  child.on("message", (message: any) => {
    if (message.type === "failure") { for (const entry of waiting.splice(0)) entry.reject(new Error("Diagnostic child failed")); return; }
    const index = waiting.findIndex(entry => entry.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message); else inbox.push(message);
  });
  child.once("exit", () => { for (const entry of waiting.splice(0)) entry.reject(new Error("Diagnostic child exited")); });
  return { send: (type: string) => child.send({ type }), wait(type: string): Promise<any> {
    const index = inbox.findIndex(entry => entry.type === type);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const entry = { type, resolve, reject }; waiting.push(entry);
      const timer = setTimeout(() => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(new Error("Diagnostic child deadline")); }, 5000);
      entry.resolve = value => { clearTimeout(timer); resolve(value); };
      entry.reject = error => { clearTimeout(timer); reject(error); };
    });
  } };
}
try {
  console.log("TW_PERFORMANCE_STAGE preflight");
  const inventory = await observer.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(inventory[0]?.count, 0); await runMigrations(databaseUrl);
  stage = "fixture"; console.log("TW_PERFORMANCE_STAGE fixture"); await resourcePostgresFixture(observer, databaseUrl);
  let peakConnections = 0;
  async function connections() {
    const rows = await observer.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where datname = current_database()`);
    peakConnections = Math.max(peakConnections, rows[0]!.count); assert.ok(peakConnections <= 10); return rows[0]!.count;
  }
  const baseConnections = await connections();
  for (const role of ["web", "api"]) {
    stage = `${role}.startup`;
    const child = fork(fileURLToPath(new URL("./performance-connection-child.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TW_DATABASE_POOL_MAX: "1", TW_PERFORMANCE_ROLE: role } });
    children.push(child); const peer = endpoint(child); const ready = await peer.wait("ready");
    assert.equal(ready.businessPoolMax, 1); await connections();
    stage = `${role}.pool-admission`;
    peer.send("hold"); await peer.wait("held"); peer.send("queue"); await peer.wait("queued");
    const state = await observer.execute<{ idle: boolean; noTransaction: boolean; lockWaiting: boolean }>(sql`
      select state = 'idle' as idle, xact_start is null as "noTransaction", coalesce(wait_event_type = 'Lock',false) as "lockWaiting"
      from pg_stat_activity where pid = ${ready.backendPid}`);
    assert.equal(state[0]?.idle, true); assert.equal(state[0]?.noTransaction, true); assert.equal(state[0]?.lockWaiting, false);
    peer.send("release"); const admitted = await peer.wait("admitted");
    cases.push({ role, phase: "pool-admission", databaseLockObserved: false, backendIdleWithoutTransaction: true,
      controlledAdmissionMs: admitted.controlledAdmissionMs });
    stage = `${role}.database-lock`;
    let gateReady!: () => void;
    const gateEntered = new Promise<void>(resolve => { gateReady = resolve; });
    const released = new Promise<void>(resolve => { releaseGate = resolve; });
    gateWork = gate.transaction(async tx => { await tx.execute(sql`select id from auth_instance_state where id = 'instance' for update`); gateReady(); await released; });
    await gateEntered; peer.send("lock");
    const started = performance.now(); let blocked = false;
    while (performance.now() - started < 2000) {
      const rows = await observer.execute<{ blocked: boolean }>(sql`select wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0 as blocked from pg_stat_activity where pid = ${ready.backendPid}`);
      if (rows[0]?.blocked) { blocked = true; break; } await delay(5);
    }
    assert.ok(blocked, "Actual database lock barrier was not observed"); releaseGate(); await gateWork; gateWork = undefined;
    const locked = await peer.wait("locked");
    cases.push({ role, phase: "database-lock", databaseLockObserved: true, controlledLifecycleMs: locked.controlledLifecycleMs });
    await connections();
  }
  stage = "shutdown";
  for (const child of children) {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.send({ type: "stop" });
    await Promise.race([exited, delay(5000).then(() => { throw new Error("Diagnostic shutdown deadline"); })]);
  }
  const afterShutdown = await connections();
  assert.ok(afterShutdown <= baseConnections + 1, "Child connections remained after shutdown");
  const storage = await observer.execute<{ bytes: number }>(sql`select pg_database_size(current_database())::float8 as bytes`);
  assert.ok(storage[0]!.bytes < 1024 ** 3); assert.equal(sourceHash(), source.implementationSha256);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source, driverVersion, configuredBusinessMax: 1,
    processes: 2, realtimePerProcessCeiling: { publisherPool: 2, separateListener: 1, total: 3 },
    connectionBudget: { childrenMaximum: 8, observerMaximum: 1, gateMaximum: 1, totalMaximum: 10, postgresMaximum: 16 },
    baseConnections, peakConnections, afterShutdown, cases, childConnectionsClosed: true, storageBytes: storage[0]!.bytes,
    limits: ["Two isolated driver processes using the same configuration helper, not full Web/API deployments or rolling restart acceptance",
      "Controlled pool and lock barriers distinguish queue locations; timings include intentional gate/IPC/observer delays and are not production wait percentiles",
      "No lock-mode/authentication/realtime behavior/default pool-size change", "Per-process caps require aggregate replica, migration and operational headroom accounting"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE unexpected"); console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ source, stage, cases })); process.exitCode = 1;
} finally {
  releaseGate(); await gateWork?.catch(() => {});
  for (const child of children) { if (child.connected) child.send({ type: "stop" }); if (child.exitCode === null) child.kill("SIGTERM"); }
  await Promise.all([observer, gate].map(db => db.$client.end({ timeout: 2 })));
}
