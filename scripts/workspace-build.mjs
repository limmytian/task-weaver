import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withWorkspaceBuildLock } from "./workspace-build-lock.mjs";
import { verifyCompiledOutputs } from "./compiled-outputs.mjs";

const root = resolve(import.meta.dirname, "..");
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);

async function run(command, args) {
  controller.signal.throwIfAborted();
  const nested = Boolean(process.env.TW_WORKSPACE_BUILD_CHILD);
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32" && !nested,
      env: { ...process.env, TW_WORKSPACE_BUILD_CHILD: "1" },
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    let timer;
    const signalChild = signal => {
      try {
        if (process.platform !== "win32" && !nested && child.pid) process.kill(-child.pid, signal);
        else if (process.platform === "win32" && !nested && child.pid) {
          const stopped = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
          if (stopped.error || stopped.status !== 0) throw new Error("Failed to stop Windows build process tree; preserve the workspace lock for inspection");
        } else child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const abort = () => {
      signalChild("SIGTERM");
      timer ??= setTimeout(() => signalChild("SIGKILL"), 5000);
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    let failure;
    child.on("error", error => { failure = error; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      // Root command completion also fences background descendants in its group.
      if (!nested && process.platform !== "win32") signalChild("SIGKILL");
      if (failure) reject(failure);
      else if (code !== 0 || signal || controller.signal.aborted) reject(new Error(`Build command failed: ${command}; exit=${code}; signal=${signal}`));
      else accept();
    });
    if (controller.signal.aborted) abort();
  });
}

const publicPackages = ["contracts", "db", "realtime", "core", "partners-gateway"];
try {
  await withWorkspaceBuildLock(root, async () => {
    const mode = process.argv[2];
    if (["build", "typecheck", "lint"].includes(mode)) {
      const require = createRequire(join(root, "package.json"));
      const turbo = join(dirname(require.resolve("turbo/package.json")), "bin/turbo");
      await run(process.execPath, [turbo, mode, ...process.argv.slice(3)]);
      for (const name of publicPackages) verifyCompiledOutputs(join(root, "packages", name));
      if (mode === "build") for (const name of ["api", "cli"]) verifyCompiledOutputs(join(root, "apps", name));
    } else if (["package-build", "package-typecheck"].includes(mode)) {
      const require = createRequire(join(process.cwd(), "package.json"));
      if (mode === "package-build") await rm(join(process.cwd(), "dist"), { recursive: true, force: true });
      await run(process.execPath, [require.resolve("typescript/bin/tsc"), ...(mode === "package-typecheck" ? ["--noEmit"] : [])]);
      if (mode === "package-build") verifyCompiledOutputs(process.cwd());
    } else if (mode === "web-build") {
      const require = createRequire(join(process.cwd(), "package.json"));
      await run(process.execPath, ["scripts/prepare-pdf-preview.mjs"]);
      await run(process.execPath, [require.resolve("next/dist/bin/next"), "build"]);
    } else throw new Error("Usage: workspace-build.mjs build|typecheck|lint|package-build|package-typecheck|web-build");
  }, { signal: controller.signal });
} catch (error) {
  console.error(error.message);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
}
