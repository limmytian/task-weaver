import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const contextKey = "TW_WORKSPACE_BUILD_LOCK";
export const lockPath = root => join(resolve(root), ".task-weaver", "build.lock");

export async function withWorkspaceBuildLock(root, action, { signal, timeoutMs = 600_000 } = {}) {
  const path = lockPath(root);
  const inherited = process.env[contextKey];
  const ownerPath = join(path, "owner.json");
  if (inherited) {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (inherited !== `${path}:${owner.token}`) throw new Error("Invalid inherited workspace build lock");
    // A stale environment cannot bypass a dead coordinator's lock.
    process.kill(owner.pid, 0);
    signal?.throwIfAborted();
    return action();
  }
  await mkdir(join(resolve(root), ".task-weaver"), { recursive: true });
  const started = performance.now();
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(path); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (performance.now() - started >= timeoutMs) {
        throw new Error(`Workspace build lock timed out: ${path}. Verify the owner and all managed writers have stopped before removing a stale lock.`);
      }
      // Never steal a lock using just a dead PID: its descendants may still write.
      await delay(100, undefined, { signal });
    }
  }
  const token = randomUUID();
  const previous = process.env[contextKey];
  try {
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    process.env[contextKey] = `${path}:${token}`;
    signal?.throwIfAborted();
    return await action();
  } finally {
    if (previous === undefined) delete process.env[contextKey];
    else process.env[contextKey] = previous;
    await rm(path, { recursive: true });
  }
}
