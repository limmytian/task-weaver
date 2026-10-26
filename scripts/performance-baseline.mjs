import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

if (process.argv.length > 2) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log("Run a disposable small synthetic HTTP baseline using an installed pgvector image. Limits: 2 DB CPUs, 1536 MiB DB memory, 4 GiB added memory, 2 GiB free host memory, 15 minutes, 1/2/4 clients at 10 offered RPS, then conditionally 20 RPS only after no skipped base-rate arrivals. No production URL, image pull, model, or load-size override is accepted. Browser/worker/SQL-plan coverage remains separate.");
    process.exit(0);
  }
  console.error("Unsupported baseline arguments; use --help");
  process.exit(1);
}

// No remote image pull, existing database URL, model process or user-selected command is accepted.
const image = "pgvector/pgvector:0.8.6-pg16-bookworm";
const name = `tw-perf-${randomUUID().slice(0, 8)}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
let child;
let creationAttempted = false;
let cleanupVerified = false;
let abortReason;
const stopChild = (signal = "SIGTERM") => {
  if (child?.pid) {
    try { process.kill(-child.pid, signal); } catch { /* The child group already exited. */ }
  }
};
const cleanup = () => {
  stopChild();
  try {
    if (creationAttempted && !cleanupVerified) {
      const inventory = () => docker("ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}");
      const found = inventory();
      if (found === name) docker("rm", "-f", "-v", name);
      else if (found) throw new Error("Unexpected cleanup inventory");
      if (inventory()) throw new Error("Disposable database remains");
      cleanupVerified = true;
    }
  } catch {
    throw new Error("Disposable database cleanup failed");
  } finally {
    // A benchmark descendant must not survive an ignored TERM or its parent exiting early.
    stopChild("SIGKILL");
  }
};
const interrupted = () => {
  cleanupWithRetry();
  process.exit(1);
};
function cleanupWithRetry() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { cleanup(); return; }
    catch { console.error("Disposable database cleanup failed"); process.exitCode = 1; }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupted);
const watchdog = setTimeout(interrupted, 15 * 60_000);
try {
  if (freemem() < 2 * 1024 ** 3) throw new Error("Insufficient free host memory");
  const identity = JSON.parse(docker("image", "inspect", image, "--format", "{{json .}}"));
  // A timed-out run command has an unknown outcome and still requires inventory/cleanup.
  creationAttempted = true;
  docker("run", "--pull=never", "--rm", "-d", "--name", name,
    "--cpus=2", "--memory=1536m", "--memory-swap=1536m", "--shm-size=256m", "--pids-limit=128",
    "-e", "POSTGRES_DB=tw_performance", "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture-only",
    "-p", "127.0.0.1::5432", image);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { docker("exec", name, "pg_isready", "-U", "fixture", "-d", "tw_performance"); ready = true; break; } catch { await delay(200); }
  }
  if (!ready) throw new Error("Disposable database startup failed");
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort;
  child = spawn("pnpm", ["exec", "tsx", "apps/api/src/performance-baseline.ts"], {
    detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--max-old-space-size=1024",
      PGOPTIONS: "-c client_min_messages=warning", TW_PERFORMANCE_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_performance` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; if (output.length > 2_000_000) stopChild(); });
  // Driver errors may contain query parameters. Never forward arbitrary child stderr.
  child.stderr.resume();
  const monitor = setInterval(() => {
    try {
      // Sum only this runner's process group; reserve 1.5 GiB for the bounded DB container.
      const processRows = execFileSync("ps", ["-axo", "rss=,pgid="], { encoding: "utf8", timeout: 2000 });
      const groupRss = processRows.split("\n").reduce((sum, line) => {
        const [rss, group] = line.trim().split(/\s+/).map(Number);
        return sum + (group === child.pid ? rss * 1024 : 0);
      }, 0);
      if (freemem() < 2 * 1024 ** 3 || groupRss > 2.5 * 1024 ** 3) { abortReason = "memory ceiling"; stopChild(); }
    } catch { abortReason = "resource monitor unavailable"; stopChild(); }
  }, 1000);
  const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
  clearInterval(monitor);
  if (code !== 0) {
    const stage = output.split("\n").filter(value => /^TW_PERFORMANCE_STAGE (preflight|fixture|isolation|wave1|wave2|wave4)$/.test(value)).at(-1)?.split(" ")[1] ?? "startup";
    console.error(`Stopped at ${stage}${abortReason ? `: ${abortReason}` : ""}`);
    throw new Error("Baseline failed; raw database errors suppressed");
  }
  const line = output.split("\n").find(value => value.startsWith("TW_PERFORMANCE_RECEIPT "));
  if (!line) throw new Error("Missing bounded baseline receipt");
  const receipt = JSON.parse(line.slice("TW_PERFORMANCE_RECEIPT ".length));
  cleanup();
  console.log(JSON.stringify({ ...receipt, databaseImage: { id: identity.Id, architecture: identity.Architecture }, cleanupVerified }, null, 2));
} catch (error) {
  console.error(error instanceof Error && ["Insufficient free host memory", "Disposable database startup failed", "Baseline failed; raw database errors suppressed", "Missing bounded baseline receipt", "Disposable database cleanup failed"].includes(error.message) ? error.message : "Baseline setup failed; sensitive diagnostics suppressed");
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  cleanupWithRetry();
}
