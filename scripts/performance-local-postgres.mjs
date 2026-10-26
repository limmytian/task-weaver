import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { macMemoryHeadroom, processSnapshot, processTree } from "./performance-resources.mjs";

const args = process.argv.slice(2);
const tierArgument = args.find(value => value.startsWith("--tier="));
const tier = tierArgument === "--tier=medium" ? "medium" : "small";
const browserArgument = args.find(value => value.startsWith("--browser-build="));
const browserBuild = browserArgument?.slice("--browser-build=".length);
const browserProfileArgument = args.find(value => value.startsWith("--browser-profile="));
const browserProfile = browserProfileArgument?.slice("--browser-profile=".length) ?? "mixed";
if (args.length === 1 && args[0] === "--help") {
  console.log("Use installed PostgreSQL/pgvector in one temporary loopback-only cluster. Limits: normal macOS memory pressure, >=2 GiB reclaimable headroom, <=1536 MiB DB RSS, <=4 GiB added RSS, <=120 DB CPU seconds, <=15 minutes; small fixture at10 offered RPS, then conditionally 20 RPS only after no skipped base-rate arrivals. Use --tier=medium for the approved10,000-task tier (2 RPS smoke, then at most10 RPS). Optional --browser-build=.next-perf-ID serves the medium fixture for one browser session; --browser-profile=selector retains all owner tasks as terminal history to isolate requirement selection from the known Board rendering failure. No installations or existing cluster access.");
  process.exit(0);
}
if (args.some(value => !["--tier=small", "--tier=medium"].includes(value) && value !== browserArgument && value !== browserProfileArgument)
    || args.length !== Number(Boolean(tierArgument)) + Number(Boolean(browserArgument)) + Number(Boolean(browserProfileArgument))
    || browserProfileArgument !== undefined && (!browserBuild || browserProfile !== "selector")
    || browserArgument !== undefined && (tier !== "medium" || !/^\.next-perf-[a-z0-9][a-z0-9-]{0,63}$/.test(browserBuild))) {
  console.error("Unsupported local baseline arguments"); process.exit(1);
}
const exec = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
const headroom = () => {
  if (platform() !== "darwin") throw new Error("This resource profile requires macOS");
  return macMemoryHeadroom(exec("vm_stat", []), exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]));
};
let root, databasePid, child, monitor, startupAttempted = false;
let peakDbRssBytes = 0, peakAddedRssBytes = 0, dbCpuSeconds = 0, samples = 0;
let stopReason;
let stage = "resource preflight";
const cpuByPid = new Map();
function stopChild(signal = "SIGTERM") {
  if (child?.pid) try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
}
function cleanup() {
  stopChild();
  try {
    if (root && startupAttempted && existsSync(join(root, "data", "postmaster.pid"))) {
      try { exec("pg_ctl", ["-D", join(root, "data"), "-m", "fast", "-w", "-t", "5", "stop"]); }
      catch { exec("pg_ctl", ["-D", join(root, "data"), "-m", "immediate", "-w", "-t", "5", "stop"]); }
    }
    if (databasePid) {
      let live = false;
      try { process.kill(databasePid, 0); live = true; } catch { /* Cluster stopped. */ }
      if (live) throw new Error("Database process remains");
    }
    if (root) { rmSync(root, { recursive: true, force: true }); if (existsSync(root)) throw new Error("Temporary files remain"); }
  } finally { stopChild("SIGKILL"); }
}
function cleanupSafely() {
  for (let i = 0; i < 2; i++) {
    try { cleanup(); return true; }
    catch { /* A transient stop failure remains retryable. */ }
  }
  console.error("Local baseline cleanup failed; temporary cluster retained for inspection");
  return false;
}
const interrupt = () => { clearInterval(monitor); cleanupSafely(); process.exit(1); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
const watchdog = setTimeout(interrupt, 15 * 60_000);
try {
  if (browserBuild && !existsSync(join("apps/web", browserBuild, "BUILD_ID"))) throw new Error("Performance build unavailable");
  if (headroom() < 2 * 1024 ** 3) throw new Error("Resource gate");
  stage = "runtime preflight";
  const postgresVersion = exec("postgres", ["--version"]);
  const share = exec("pg_config", ["--sharedir"]);
  const library = exec("pg_config", ["--pkglibdir"]);
  const vectorControl = readFileSync(join(share, "extension", "vector.control"), "utf8");
  if (!existsSync(join(library, platform() === "darwin" ? "vector.dylib" : "vector.so"))) throw new Error("Existing vector library unavailable");
  const vectorVersion = vectorControl.match(/default_version\s*=\s*'([0-9.]+)'/)?.[1];
  if (!vectorVersion) throw new Error("Existing vector version unavailable");
  root = mkdtempSync(join(tmpdir(), "tw-perf-local-"));
  stage = "cluster initialization";
  const password = randomBytes(24).toString("hex");
  const passwordFile = join(root, "password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  exec("initdb", ["-D", join(root, "data"), "-U", "fixture", "--pwfile", passwordFile, "--auth-local=trust", "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  rmSync(passwordFile);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  writeFileSync(join(root, "data", "postgresql.auto.conf"), [
    "listen_addresses = '127.0.0.1'", `port = ${port}`, `unix_socket_directories = '${root.replaceAll("'", "''")}'`,
    "max_connections = 16", "shared_buffers = '64MB'", "work_mem = '4MB'", "maintenance_work_mem = '32MB'",
    "max_parallel_workers = 0", "max_parallel_workers_per_gather = 0", "statement_timeout = '5s'", "lock_timeout = '4s'",
    "log_min_messages = 'fatal'", "log_min_error_statement = 'panic'", "log_parameter_max_length = 0", "log_parameter_max_length_on_error = 0",
  ].join("\n"));
  startupAttempted = true;
  stage = "cluster startup";
  exec("pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10", "start"]);
  databasePid = Number(readFileSync(join(root, "data", "postmaster.pid"), "utf8").split("\n")[0]);
  exec("createdb", ["-h", root, "-p", String(port), "-U", "fixture", "tw_performance"]);
  stage = "worker execution";
  child = spawn("pnpm", ["exec", "tsx", browserBuild ? "apps/api/src/performance-browser-fixture.ts" : "apps/api/src/performance-baseline.ts"], { detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--max-old-space-size=1024", PGOPTIONS: "-c client_min_messages=warning", TW_PERFORMANCE_TIER: tier,
      TW_PERFORMANCE_BROWSER_BUILD: browserBuild ?? "", TW_PERFORMANCE_BROWSER_READY_FILE: join(root, "browser-ready.json"),
      TW_PERFORMANCE_BROWSER_PROFILE: browserProfile,
      TW_PERFORMANCE_DATABASE_URL: `postgres://fixture:${password}@127.0.0.1:${port}/tw_performance` } });
  let output = "";
  let browserReadyPublished = false;
  child.stdout.on("data", chunk => {
    output += chunk;
    if (browserBuild && !browserReadyPublished && output.includes("TW_PERFORMANCE_BROWSER_READY\n")) {
      const ready = JSON.parse(readFileSync(join(root, "browser-ready.json"), "utf8"));
      console.log(JSON.stringify({ browserReady: true, ...ready, readyFile: join(root, "browser-ready.json") }));
      browserReadyPublished = true;
    }
    if (output.length > 2_000_000) { stopReason = "output ceiling"; stopChild(); } });
  child.stderr.resume();
  monitor = setInterval(() => {
    try {
      const snapshot = processSnapshot(exec("ps", ["-axo", "pid=,ppid=,rss=,time="]));
      const database = processTree(snapshot, databasePid);
      const api = processTree(snapshot, child.pid);
      if (!database.length) throw new Error("Database process unavailable");
      for (const row of database) {
        dbCpuSeconds += Math.max(0, row.cpuSeconds - (cpuByPid.get(row.pid) ?? 0)); cpuByPid.set(row.pid, row.cpuSeconds);
      }
      const dbRss = database.reduce((sum, row) => sum + row.rssBytes, 0);
      const added = dbRss + api.reduce((sum, row) => sum + row.rssBytes, 0) + (snapshot.find(row => row.pid === process.pid)?.rssBytes ?? 0);
      peakDbRssBytes = Math.max(peakDbRssBytes, dbRss); peakAddedRssBytes = Math.max(peakAddedRssBytes, added); samples++;
      if (headroom() < 2 * 1024 ** 3 || dbRss > 1536 * 1024 ** 2 || added > (browserBuild ? 3 : 4) * 1024 ** 3 || dbCpuSeconds > 120) throw new Error("Resource ceiling");
    } catch { stopReason = "resource ceiling or monitor unavailable"; stopChild(); }
  }, 1000);
  const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
  clearInterval(monitor);
  stage = output.split("\n").filter(line => /^TW_PERFORMANCE_STAGE (preflight|fixture|isolation|wave1|wave2|wave4)$/.test(line)).at(-1)?.split(" ")[1] ?? "startup";
  if (code !== 0 || stopReason) {
    const failure = output.split("\n").find(line => /^TW_PERFORMANCE_FAILURE (workload_error|resource_limit|credential_isolation|unexpected)$/.test(line))?.split(" ")[1];
    console.error(`Local baseline stopped at ${stage}: ${stopReason ?? failure ?? "worker failure; raw diagnostics suppressed"}`);
    const partial = output.split("\n").find(line => line.startsWith("TW_PERFORMANCE_PARTIAL "));
    if (partial) {
      const retained = JSON.parse(partial.slice("TW_PERFORMANCE_PARTIAL ".length));
      cleanup();
      console.log(JSON.stringify({ ...retained, completed: false, cleanupVerified: true,
        localDatabase: { postgresVersion, vectorVersion, peakDbRssBytes, peakAddedRssBytes, sampledDbCpuSeconds: dbCpuSeconds, resourceSamples: samples } }, null, 2));
    }
    throw new Error("Baseline failed");
  }
  const line = output.split("\n").find(line => line.startsWith("TW_PERFORMANCE_RECEIPT "));
  if (!line) throw new Error("Baseline receipt unavailable");
  const receipt = JSON.parse(line.slice("TW_PERFORMANCE_RECEIPT ".length));
  stage = "cleanup";
  cleanup();
  console.log(JSON.stringify({ ...receipt, localDatabase: { postgresVersion, vectorVersion, peakDbRssBytes, peakAddedRssBytes, sampledDbCpuSeconds: dbCpuSeconds, resourceSamples: samples }, cleanupVerified: true }, null, 2));
} catch {
  console.error(`Local performance baseline did not complete at ${stage}; sensitive diagnostics suppressed`); process.exitCode = 1;
} finally {
  clearInterval(monitor); clearTimeout(watchdog);
  if (!cleanupSafely()) process.exitCode = 1;
}
