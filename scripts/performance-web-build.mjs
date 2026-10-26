import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { macMemoryHeadroom, processSnapshot, processTree } from "./performance-resources.mjs";

const web = resolve("apps/web");
const directory = `.next-perf-${randomUUID().slice(0, 8)}`;
const destination = join(web, directory);
const exec = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
const headroom = () => macMemoryHeadroom(exec("vm_stat", []), exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]));
const backups = new Map(["tsconfig.json", "next-env.d.ts"].map(file => [file, readFileSync(join(web, file), "utf8")]));
let child, monitor, complete = false, peakRssBytes = 0, cpuSeconds = 0, stopReason, exitCode;
let diagnostics = "";
const cpu = new Map();
function stop(signal = "SIGTERM") { if (child?.pid) try { process.kill(-child.pid, signal); } catch { /* Already stopped. */ } }
function restoreGeneratedSources() {
  for (const [file, before] of backups) {
    const path = join(web, file), after = readFileSync(path, "utf8");
    if (after === before) continue;
    let equivalent;
    if (file === "next-env.d.ts") equivalent = after.replaceAll(directory, ".next") === before;
    else {
      const parsed = JSON.parse(after);
      parsed.include = parsed.include.filter(entry => !entry.includes(directory));
      equivalent = JSON.stringify(parsed) === JSON.stringify(JSON.parse(before));
    }
    if (!equivalent) throw new Error("Unexpected source changes retained for inspection");
    writeFileSync(path, before);
  }
}
const interrupt = () => { stop("SIGKILL"); process.exitCode = 1; };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
const watchdog = setTimeout(interrupt, 6 * 60_000);
try {
  if (headroom() < 2 * 1024 ** 3) throw new Error("Resource gate");
  mkdirSync(destination);
  const require = createRequire(join(web, "package.json"));
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack"], {
    cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--max-old-space-size=1536", RAYON_NUM_THREADS: "2",
      NEXT_TELEMETRY_DISABLED: "1", TW_PERFORMANCE_WEB_DIST_DIR: directory,
      DATABASE_URL: "postgres://fixture:fixture-only@127.0.0.1:1/tw_performance",
      TW_AUTH_SECRET: randomBytes(32).toString("hex"), TW_AUTH_BASE_URL: "http://127.0.0.1:3001",
      TW_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3000", TW_API_URL: "http://127.0.0.1:1", TW_PRESET_SKILLS_SYNC: "disabled" },
  });
  const capture = chunk => { diagnostics = (diagnostics + chunk).slice(-500_000); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  monitor = setInterval(() => {
    try {
      const tree = processTree(processSnapshot(exec("ps", ["-axo", "pid=,ppid=,rss=,time="])), child.pid);
      const rss = tree.reduce((sum, row) => sum + row.rssBytes, 0);
      peakRssBytes = Math.max(peakRssBytes, rss);
      for (const row of tree) { cpuSeconds += Math.max(0, row.cpuSeconds - (cpu.get(row.pid) ?? 0)); cpu.set(row.pid, row.cpuSeconds); }
      if (rss > 3 * 1024 ** 3 || cpuSeconds > 120 || headroom() < 2 * 1024 ** 3) { stopReason = "resource ceiling"; stop("SIGKILL"); }
    } catch { stopReason = "resource monitor unavailable"; stop("SIGKILL"); }
  }, 1000);
  const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
  exitCode = code;
  clearInterval(monitor);
  if (code !== 0 || !existsSync(join(destination, "BUILD_ID"))) throw new Error("Build failed");
  restoreGeneratedSources();
  complete = true;
  console.log(JSON.stringify({ directory, bundler: "webpack", buildId: readFileSync(join(destination, "BUILD_ID"), "utf8").trim(),
    nextConfigSha256: createHash("sha256").update(readFileSync(join(web, "next.config.ts"))).digest("hex"), peakRssBytes, sampledCpuSeconds: cpuSeconds }));
} catch {
  // Compiler diagnostics are inspected transiently; no raw logs enter the performance receipt.
  const category = stopReason ?? (diagnostics.includes("Failed to load next.config") ? "configuration"
    : diagnostics.includes("Module not found") ? "module resolution"
    : diagnostics.includes("Type error:") ? "type checking"
    : diagnostics.includes("Turbopack build failed") ? "Turbopack compilation" : "build command");
  console.error(JSON.stringify({ category, exitCode, peakRssBytes, sampledCpuSeconds: cpuSeconds }));
  console.error("Isolated performance build failed; raw diagnostics suppressed"); process.exitCode = 1;
} finally {
  clearInterval(monitor); clearTimeout(watchdog); stop("SIGKILL");
  try { restoreGeneratedSources(); }
  catch { console.error("Generated source changes require inspection; originals were not overwritten"); process.exitCode = 1; }
  if (!complete) rmSync(destination, { recursive: true, force: true });
}
