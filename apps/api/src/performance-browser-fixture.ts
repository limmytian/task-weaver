import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, requirements, tasks, documents, taskDependencies, documentTaskLinks, documentRequirementLinks } from "@task-weaver/db";
import { performanceFixture, performanceBatches } from "./performance-fixture";
import { checkPerformanceBoard } from "./performance-board-checks";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

// Public, disposable fixture credentials only. They never authenticate to an existing instance.
const email = "performance-owner@example.test";
const password = "fixture-only-browser-performance-20261026";
const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const readyFile = process.env.TW_PERFORMANCE_BROWSER_READY_FILE!;
let directory = process.env.TW_PERFORMANCE_BROWSER_BUILD!;
const compareDirectory = process.env.TW_PERFORMANCE_BROWSER_COMPARE_BUILD;
assert.ok(!compareDirectory || /^\.next-perf-[a-z0-9-]+$/.test(compareDirectory));
const profile = process.env.TW_PERFORMANCE_BROWSER_PROFILE ?? "mixed";
assert.ok(profile === "mixed" || profile === "selector");
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
assert.ok(readyFile && /^\.next-perf-[a-z0-9-]+$/.test(directory));
const db = createDb(databaseUrl, { maxConnections: 1, measureQueries: true });
let api: ReturnType<typeof serve> | undefined, web: ReturnType<typeof spawn> | undefined;
const freePort = async (host = "127.0.0.1") => {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, host, resolve));
  const address = socket.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port;
};
try {
  const tables = await db.execute<{ count: string }>(sql`select count(*) as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%'
    and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(Number(tables[0]?.count), 0, "Browser fixture requires an empty database");
  await runMigrations(databaseUrl);
  const apiPort = await freePort(), webPort = await freePort("::1");
  const apiOrigin = `http://127.0.0.1:${apiPort}`, webOrigin = `http://[::1]:${webPort}`;
  const f = await resourcePostgresFixture(db, databaseUrl, { password, ownerEmail: email, apiOrigin, webOrigin });
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  const generated = performanceFixture([f.project.id, other.id], [f.owner.context.actor.id, f.outsider.context.actor.id], "medium");
  // Isolate selector work from the already-known unbounded Board: retain all tasks as terminal history.
  const browserTasks = profile === "selector" ? generated.taskRows.map(row => row.projectId === f.project.id
    ? { ...row, status: "done" as const, completedAt: row.updatedAt } : row) : generated.taskRows;
  const fixtureHash = profile === "mixed" ? generated.hash : createHash("sha256").update(JSON.stringify({
    baseFixtureHash: generated.hash, profile, ownerTasks: "All 5000 tasks are done; default Board excludes terminal history",
  })).digest("hex");
  for (const batch of performanceBatches(generated.requirementRows)) await db.insert(requirements).values(batch);
  for (const batch of performanceBatches(browserTasks)) await db.insert(tasks).values(batch);
  await db.insert(documents).values(generated.documentRows);
  for (const batch of performanceBatches(generated.dependencies)) await db.insert(taskDependencies).values(batch);
  await db.insert(documentTaskLinks).values(generated.taskLinks); await db.insert(documentRequirementLinks).values(generated.requirementLinks);
  await db.execute(sql`ANALYZE`);
  console.log("TW_PERFORMANCE_STAGE fixture");
  if (compareDirectory && profile === "mixed") {
    const audit = await checkPerformanceBoard(f, browserTasks.filter(row => row.projectId === f.project.id
      && row.status !== "done" && row.status !== "cancelled").map(row => row.id),
      generated.requirementRows.find(row => row.projectId === other.id)!.id);
    writeFileSync(`${readyFile}.board-audit.json`, JSON.stringify(audit), { mode: 0o600 });
  }
  api = serve({ hostname: "127.0.0.1", port: apiPort, fetch: f.app.fetch });
  const require = createRequire(resolve("apps/web/package.json"));
  const stopWeb = async () => {
    if (!web || web.exitCode !== null) return;
    const current = web;
    current.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { current.kill("SIGKILL"); resolve(); }, 3000);
      current.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  const startWeb = async () => {
    web = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "::1", "-p", String(webPort)], {
    cwd: resolve("apps/web"), stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--max-old-space-size=1024",
      NEXT_TELEMETRY_DISABLED: "1", TW_PERFORMANCE_WEB_DIST_DIR: directory, DATABASE_URL: databaseUrl,
      TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: apiOrigin, TW_AUTH_TRUSTED_ORIGINS: webOrigin,
      TW_API_URL: apiOrigin, TW_PRESET_SKILLS_SYNC: "disabled" },
  });
  let available = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (web.exitCode !== null) break;
    try {
      const response = await fetch(`${webOrigin}/login`, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer(); if (response.ok) { available = true; break; }
    } catch { /* Wait for the owned server only. */ }
    await delay(200);
  }
  assert.ok(available, "Isolated browser server failed to start");
  writeFileSync(readyFile, JSON.stringify({ webOrigin, apiOrigin, projectId: f.project.id, fixtureHash,
    profile, baseFixtureHash: generated.hash,
    fixedRequirementId: generated.requirementRows[0]!.id,
    buildDirectory: directory, buildId: readFileSync(join(resolve("apps/web"), directory, "BUILD_ID"), "utf8").trim(),
    tasks: generated.counts.tasks, requirements: generated.counts.requirements, apiPoolMax: 1, webPoolMax: 10, realtimePoolMax: 2 }), { mode: 0o600 });
  };
  await startWeb();
  console.log("TW_PERFORMANCE_BROWSER_READY");
  // Sequential phases reuse rows/auth/ports. Never run both Web builds concurrently.
  let switched = false;
  while (!existsSync(`${readyFile}.done`)) {
    if (compareDirectory && !switched && existsSync(`${readyFile}.next`)) {
      switched = true;
      await stopWeb();
      directory = compareDirectory;
      await startWeb();
      console.log("TW_PERFORMANCE_BROWSER_SWITCHED");
    }
    await delay(200);
  }
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ browserFixture: true, fixtureHash, profile, baseFixtureHash: generated.hash,
    tasks: generated.counts.tasks, requirements: generated.counts.requirements, directory,
    buildId: readFileSync(join(resolve("apps/web"), directory, "BUILD_ID"), "utf8").trim() }));
} catch (error) {
  const failure = error as { code?: unknown; operator?: unknown; actual?: unknown; expected?: unknown };
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ browserSetupFailed: true,
    category: error instanceof assert.AssertionError ? "assertion" : error instanceof Error ? error.name : "unknown",
    code: typeof failure.code === "string" && /^[A-Z0-9_]{1,40}$/.test(failure.code) ? failure.code : undefined,
    actual: typeof failure.actual === "number" ? failure.actual : undefined,
    expected: typeof failure.expected === "number" ? failure.expected : undefined }));
  throw new Error("Isolated browser fixture failed");
} finally {
  if (web?.pid && web.exitCode === null) {
    web.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { web!.kill("SIGKILL"); resolve(); }, 3000);
      web!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (api) await new Promise<void>(resolve => { api!.close(() => resolve()); if ("closeAllConnections" in api!) api!.closeAllConnections(); });
  await db.$client.end({ timeout: 2 });
}
