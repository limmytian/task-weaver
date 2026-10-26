import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Database } from "@task-weaver/db";
import { sql } from "drizzle-orm";
import { runPerformanceWave } from "./performance-workload";
import type { resourcePostgresFixture } from "./resource-postgres-fixture";

type Fixture = Awaited<ReturnType<typeof resourcePostgresFixture>>;
export async function compareMixedControl(db: Database, databaseUrl: string, f: Fixture, writeTaskId: string, oracle: string) {
  const cases: unknown[] = [];
  const start = async (variant: string) => {
    const child = fork(fileURLToPath(new URL("./performance-api-child.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--max-old-space-size=768",
        PGOPTIONS: "-c client_min_messages=warning", TW_PERFORMANCE_DATABASE_URL: databaseUrl },
    });
    const wait = (type: string) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error("Owned API fixture deadline")); }, 20_000);
      const message = (value: any) => { if (value.type === type) { cleanup(); resolve(value); } };
      const exited = () => { cleanup(); reject(Error("Owned API fixture stopped")); };
      const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exited); };
      child.on("message", message); child.once("exit", exited);
    });
    try {
      const listening = await wait("listening"); const ready = wait("ready");
      child.send({ type: "configure", variant, configuration: f.configuration }); await ready;
      return { child, origin: `http://127.0.0.1:${listening.port}` };
    } catch (error) { child.kill("SIGKILL"); throw error; }
  };
  const stop = (child: ChildProcess) => new Promise<void>(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); child.send({ type: "stop" });
  });
  for (const variant of ["legacy", "candidate", "legacy", "candidate"]) {
    const nodes: Awaited<ReturnType<typeof start>>[] = [];
    try {
      // Sequential startup keeps transient compiler memory below the same guarded ceiling.
      nodes.push(await start(variant));
      const waves = [];
      for (const rate of [2, 10]) {
        if (rate === 10) nodes.push(await start(variant));
        const statuses: Record<string, number> = {};
        const samples: Array<{ operation: string; milliseconds: number; queries: number; entryMs: number; lockMs: number; bytes: number }> = [];
        let monitorBusy = false, lockWaitSamples = 0, sampledWaitingBackends = 0;
        const monitor = setInterval(() => {
          if (monitorBusy) return; monitorBusy = true;
          void db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`)
            .then(rows => { lockWaitSamples++; sampledWaitingBackends += rows[0]?.count ?? 0; }).finally(() => { monitorBusy = false; });
        }, 100);
        try {
          const result = await runPerformanceWave({ count: rate === 2 ? 10 : 500, intervalMs: 1000 / rate, concurrency: 4,
            request: async index => {
              const node = nodes[index % nodes.length]!;
              const read = index % 10 < 7; const started = performance.now();
              const response = await fetch(read ? `${node.origin}/performance/queue` : `${node.origin}/api/v1/tasks/${writeTaskId}`, {
                method: read ? "GET" : "PATCH", headers: read ? f.owner.headers : f.outsider.headers,
                body: read ? undefined : JSON.stringify({ title: `Synthetic mixed write ${index}` }), signal: AbortSignal.timeout(5000),
              });
              const text = await response.text(); statuses[response.status] = (statuses[response.status] ?? 0) + 1; assert.equal(response.status, 200);
              if (read) assert.equal(createHash("sha256").update(JSON.stringify(JSON.parse(text).items)).digest("hex"), oracle);
              samples.push({ operation: read ? "queue" : "write", milliseconds: performance.now() - started,
                queries: Number(response.headers.get("x-tw-fixture-queries")), entryMs: Number(response.headers.get("x-tw-fixture-entry-ms")),
                lockMs: Number(response.headers.get("x-tw-fixture-lock-ms")), bytes: Buffer.byteLength(text) });
            } });
          waves.push({ apiProcesses: nodes.length, statuses, offeredRps: rate, smoke: rate === 2, ...result, samples, lockWaitSamples, sampledWaitingBackends });
          if (result.failures) console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ mixedControlFailed: true, variant, waves }));
          assert.equal(result.failures, 0);
        } finally { clearInterval(monitor); }
      }
      cases.push({ variant, apiProcesses: 2, businessPoolPerProcess: 1, waves });
    } finally { await Promise.all(nodes.map(node => stop(node.child))); }
  }
  return { cases, limits: ["Fixed70/30 scheduled mix excluding2RPS smoke;skipped offers are explicit,not retried",
    "Header transaction-entry timing includes pool reservation and BEGIN scheduling,not isolated pool wait", "Lock samples are interval observations,not wait-time accounting",
    "Two actual OS API processes;fixture queue route uses current credential verification and the normal live resource factory"] };
}
