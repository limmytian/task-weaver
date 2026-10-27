import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { createDb, databasePoolOptions } from "@task-weaver/db";
import { initRealtime, subscribe, emit, shutdown } from "@task-weaver/realtime";

const url = new URL(process.env.TW_PERFORMANCE_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
const options = databasePoolOptions(process.env); assert.equal(options.maxConnections, 1);
const db = createDb(url.href, options);
const role = process.env.TW_PERFORMANCE_ROLE;
assert.ok(role === "web" || role === "api");
const taskId = role === "web" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
let held: Awaited<ReturnType<typeof db.$client.reserve>> | undefined;
let stopping = false;
const send = (value: object) => process.send?.(value);
async function stop() {
  if (stopping) return; stopping = true; held?.release(); held = undefined;
  await shutdown(); await db.$client.end({ timeout: 2 }); process.disconnect?.();
}
process.on("message", async (message: { type: string }) => {
  try {
    if (message.type === "hold") { held = await db.$client.reserve(); send({ type: "held" }); }
    else if (message.type === "queue") {
      assert.ok(held); const started = performance.now();
      const pending = db.$client.reserve().then(connection => {
        connection.release(); send({ type: "admitted", controlledAdmissionMs: performance.now() - started });
      });
      send({ type: "queued" }); await pending;
    } else if (message.type === "release") { held?.release(); held = undefined; }
    else if (message.type === "lock") {
      const started = performance.now();
      await db.transaction(async tx => {
        await tx.execute(sql`select id from auth_instance_state where id = 'instance' for update`);
      });
      send({ type: "locked", controlledLifecycleMs: performance.now() - started });
    } else if (message.type === "stop") await stop();
    else throw new Error("Unsupported diagnostic command");
  } catch { send({ type: "failure" }); await stop(); process.exitCode = 1; }
});
try {
  const backend = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  await initRealtime(url.href);
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic notification deadline")), 5000);
    const remove = subscribe(event => {
      if (event.type !== "task_updated" || event.taskId !== taskId) return;
      clearTimeout(timer); remove(); resolve();
    });
  });
  emit({ type: "task_updated", projectId: null, taskId }); await received;
  send({ type: "ready", backendPid: backend[0]!.pid, businessPoolMax: db.$client.options.max });
} catch { send({ type: "failure" }); await stop(); process.exitCode = 1; }
process.once("disconnect", () => { void stop(); });
