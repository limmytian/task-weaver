import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, requirements, tasks, documents, taskDependencies, documentTaskLinks, documentRequirementLinks, measureDatabaseWork } from "@task-weaver/db";
import { performanceFixture, performanceBatches } from "./performance-fixture";
import { checkKanbanColumns } from "./performance-kanban-columns";
import { checkPerformanceWorkspace } from "./performance-workspace-checks";
import { checkPerformanceBoard } from "./performance-board-checks";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

// Public, disposable fixture credentials only. They never authenticate to an existing instance.
const email = "performance-owner@example.test";
const fixtureSecret = "browser-perf-2026";
const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const readyFile = process.env.TW_PERFORMANCE_BROWSER_READY_FILE!;
let directory = process.env.TW_PERFORMANCE_BROWSER_BUILD!;
const compareDirectory = process.env.TW_PERFORMANCE_BROWSER_COMPARE_BUILD;
assert.ok(!compareDirectory || /^\.next-perf-[a-z0-9-]+$/.test(compareDirectory));
const profile = process.env.TW_PERFORMANCE_BROWSER_PROFILE ?? "mixed";
assert.ok(profile === "mixed" || profile === "selector" || profile === "document" || profile === "document-large");
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
  const f = await resourcePostgresFixture(db, databaseUrl, { password: fixtureSecret, ownerEmail: email, apiOrigin, webOrigin });
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  const generated = performanceFixture([f.project.id, other.id], [f.owner.context.actor.id, f.outsider.context.actor.id], "medium");
  // Isolate selector work from the already-known unbounded Board: retain all tasks as terminal history.
  const browserTasks = profile === "selector" ? generated.taskRows.map(row => row.projectId === f.project.id
    ? { ...row, status: "done" as const, completedAt: row.updatedAt } : row) : generated.taskRows;
  const fixtureHash = profile === "mixed" ? generated.hash : createHash("sha256").update(JSON.stringify({
    baseFixtureHash: generated.hash, profile, ownerTasks: "All 5000 tasks are done; default Board excludes terminal history",
  })).digest("hex");
  const browserDocuments = profile.startsWith("document") ? generated.documentRows.map((row, index) => index === 0
    ? { ...row, content: Array.from({ length: profile === "document-large" ? 384 : 96 }, (_, section) => `## Synthetic section ${section}\n\nA fixed paragraph with **bold**, *emphasis*, \`inline code\` and [[${section % 51 === 50 ? "Synthetic document 0" : section % 51 === 49 ? "Missing synthetic title" : `Synthetic document ${section % 51 + 1}`}]].\n\n| Column | Value |\n| --- | --- |\n| Example | ${section} |\n\n- First item\n- Second item\n`).join("\n") } : row) : generated.documentRows;
  if (profile.startsWith("document")) assert.ok(Buffer.byteLength(browserDocuments[0]!.content) <= (profile === "document-large" ? 96 : 32) * 1024);
  const effectiveFixtureHash = profile.startsWith("document") ? createHash("sha256").update(JSON.stringify({ baseFixtureHash: generated.hash,
    profile, content: browserDocuments[0]!.content })).digest("hex") : fixtureHash;
  for (const batch of performanceBatches(generated.requirementRows)) await db.insert(requirements).values(batch);
  for (const batch of performanceBatches(browserTasks)) await db.insert(tasks).values(batch);
  await db.insert(documents).values(browserDocuments);
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
  if (profile.startsWith("document")) {
    const samples = [];
    for (const query of ["", "&view=summary&page=1&pageSize=10"]) {
      const { value, measurement } = await measureDatabaseWork(async () => {
        const response = await f.app.request(`/api/v1/documents?projectId=${f.project.id}&includeGlobal=true${query}`, { headers: f.owner.headers });
        assert.equal(response.status, 200);
        const text = await response.text();
        const body = JSON.parse(text);
        assert.equal(query ? body.items.length : body.length, query ? 10 : 50);
        if (query) { assert.equal(body.total, 50); assert.ok(body.items.every((item: object) => !("content" in item))); }
        return { bytes: Buffer.byteLength(text), rows: query ? body.items.length : body.length };
      });
      samples.push({ view: query ? "summary10" : "legacy-full", ...value, database: measurement });
    }
    writeFileSync(`${readyFile}.document-audit.json`, JSON.stringify({ samples, bodiesNotRetained: true }), { mode: 0o600 });
  }
  const columnAudit = await checkKanbanColumns(db, f);
  writeFileSync(`${readyFile}.columns-audit.json`, JSON.stringify(columnAudit), { mode: 0o600 });
  const workspaceAudit = await checkPerformanceWorkspace(db, f);
  writeFileSync(`${readyFile}.workspace-audit.json`, JSON.stringify(workspaceAudit), { mode: 0o600 });
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
  writeFileSync(readyFile, JSON.stringify({ webOrigin, apiOrigin, projectId: f.project.id, fixtureHash: effectiveFixtureHash, documentId: browserDocuments[0]!.id, documentBytes: Buffer.byteLength(browserDocuments[0]!.content),
    profile, baseFixtureHash: generated.hash,
    fixedRequirementId: generated.requirementRows[0]!.id,
    buildDirectory: directory, buildId: readFileSync(join(resolve("apps/web"), directory, "BUILD_ID"), "utf8").trim(),
    tasks: generated.counts.tasks, requirements: generated.counts.requirements, apiPoolMax: 1, webPoolMax: 10, realtimePoolMax: 2 }), { mode: 0o600 });
  };
  await startWeb();
  console.log("TW_PERFORMANCE_BROWSER_READY");
  // Sequential phases reuse rows/auth/ports. Never run both Web builds concurrently.
  let switched = false;
  let paused = false;
  let viewer: Awaited<ReturnType<typeof f.createHuman>> | undefined;
  while (!existsSync(`${readyFile}.done`)) {
    if (!paused && existsSync(`${readyFile}.pause`)) {
      paused = true;
      rmSync(`${readyFile}.pause`);
      await stopWeb();
      writeFileSync(`${readyFile}.paused`, "owned Web process stopped");
    }
    if (paused && !switched && existsSync(`${readyFile}.next-build`)) {
      const requested = readFileSync(`${readyFile}.next-build`, "utf8").trim();
      assert.ok(/^\.next-perf-[a-z0-9-]+$/.test(requested));
      assert.ok(existsSync(join(resolve("apps/web"), requested, "BUILD_ID")));
      directory = requested;
      switched = true;
      paused = false;
      await startWeb();
      console.log("TW_PERFORMANCE_BROWSER_SWITCHED");
    }
    if (compareDirectory && !switched && existsSync(`${readyFile}.next`)) {
      switched = true;
      await stopWeb();
      directory = compareDirectory;
      await startWeb();
      console.log("TW_PERFORMANCE_BROWSER_SWITCHED");
    }
    const actionFile = `${readyFile}.viewer-action`;
    if (existsSync(actionFile)) {
      const action = readFileSync(actionFile, "utf8").trim(); rmSync(actionFile);
      assert.ok(["create", "revoke", "restore"].includes(action));
      if (action === "create") { assert.ok(!viewer); viewer = await f.createHuman(); }
      assert.ok(viewer);
      if (action === "revoke") await f.identity.removeMembership(f.owner.headers, f.project.id, viewer.context.actor.id);
      else await f.identity.setMembership(f.owner.headers, f.project.id, viewer.context.actor.id, { role: "viewer" });
      writeFileSync(`${readyFile}.viewer-state.json`, JSON.stringify({ email: viewer.account.email, state: action }), { mode: 0o600 });
    }
    await delay(200);
  }
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ browserFixture: true, fixtureHash: effectiveFixtureHash, profile, baseFixtureHash: generated.hash,
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
