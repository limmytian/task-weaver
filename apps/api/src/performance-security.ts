import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { sql } from "drizzle-orm";
import { checkPerformanceRealtime } from "./performance-realtime-checks";
import { createDb } from "@task-weaver/db";

const input = new URL(process.env.TW_PERFORMANCE_DATABASE_URL!);
assert.equal(input.hostname, "127.0.0.1"); assert.equal(input.pathname, "/tw_performance");
const db = createDb(input.href, { maxConnections: 1 });
const suites = [
  { database: "tw_update_reason_e2e", variable: "TW_UPDATE_REASON_E2E_DATABASE_URL", file: "update-reason" },
  { database: "tw_auth_e2e", variable: "TW_AUTH_E2E_DATABASE_URL", file: "authentication" },
  { database: "tw_console_e2e", variable: "TW_CONSOLE_E2E_DATABASE_URL", file: "worker-console" },
  { database: "tw_execution_recovery_e2e", variable: "TW_EXECUTION_RECOVERY_E2E_DATABASE_URL", file: "execution-recovery" },
] as const;
const results: unknown[] = [];
try {
  const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(row?.count, 0);
  for (const suite of suites) {
    // Static names only,inside this newly-created loopback cluster;no existing database is touched.
    await db.execute(sql`CREATE DATABASE ${sql.identifier(suite.database)}`);
    const url = new URL(input); url.pathname = `/${suite.database}`;
    let output = "";
    const child = spawn("pnpm", ["exec", "tsx", "--test", "--test-reporter=tap", `apps/api/src/${suite.file}.postgres-e2e.test.ts`], {
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME,
        NODE_OPTIONS: "--max-old-space-size=1024", PGOPTIONS: "-c client_min_messages=warning",
        TW_DATABASE_POOL_MAX: "1", TW_DAEMON_MODE: suite.file === "execution-recovery" ? "sse" : "polling", [suite.variable]: url.href },
    });
    const capture = (chunk: Buffer) => { output = (output + chunk).slice(-500_000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    const status = await new Promise<number | null>(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
    clearTimeout(timer);
    const count = (label: string) => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? -1);
    const diagnostic = status === 0 ? undefined : {
      expected: Number(output.match(/^\s+expected: (\d+)$/m)?.[1] ?? -1),
      actual: Number(output.match(/^\s+actual: (\d+)$/m)?.[1] ?? -1),
      code: output.match(/^\s+code: ['"]?([A-Z0-9_]+)['"]?$/m)?.[1],
      frames: [...output.matchAll(new RegExp(`${suite.file}\\.postgres-e2e\\.test\\.ts:(\\d+)`, "g"))].map(match => Number(match[1])).slice(0, 8),
    };
    const result = { diagnostic, suite: suite.file, status, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
    results.push(result);
    assert.equal(status, 0); assert.ok(result.tests > 0); assert.equal(result.fail, 0); assert.equal(result.skipped, 0);
    await db.execute(sql`DROP DATABASE ${sql.identifier(suite.database)}`);
  }
  const realtime = await checkPerformanceRealtime(db, input.href);
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ securityContracts: true, results, realtime,
    limits: ["Existing isolated HTTP tests and two console API peers;no model execution or production access", "Raw TAP,credentials,tool output and bodies are transient and excluded from this receipt"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE workload_error");
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ securityContracts: true, results })); process.exitCode = 1;
} finally { await db.$client.end({ timeout: 2 }); }
