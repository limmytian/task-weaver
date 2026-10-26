import { performance } from "node:perf_hooks";
import { checkWorkspaceIsolation } from "./performance-workspace-contract";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorizedEventStream, createResourceServices, createRequirementSchema } from "@task-weaver/core";
import { runMigrations, type Database } from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

/** Deterministic bounded event/authority cases;no body or credential enters the receipt. */
export async function checkPerformanceRealtime(db: Database, databaseUrl: string) {
  await runMigrations(databaseUrl);
  const f = await resourcePostgresFixture(db, databaseUrl);
  const service = createResourceServices(f.owner.context);
  const requirement = await service.requirementService.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: "Realtime fixture" }), f.owner.context.actor);
  const task = await service.taskService.createTask(db, { projectId: f.project.id, requirementId: requirement.id, title: "Realtime fixture" }, f.owner.context.actor);
  const viewer = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, viewer.context.actor.id, { role: "viewer" });
  const controllers: AbortController[] = [];
  const decoder = new TextDecoder();
  const stream = async (context = f.owner.context, resume = false) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await createAuthorizedEventStream(db, context, new Request("http://127.0.0.1:3001/api/events", {
      signal: controller.signal, headers: resume ? { "Last-Event-ID": "old-connection-42" } : undefined,
    }));
    return { controller, reader: response.body!.getReader() };
  };
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Realtime test deadline")), 4000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const live = await stream(viewer.context);
    assert.match(decoder.decode((await read(live.reader)).value), /"resume":"resync"/);
    const foreignTask = randomUUID();
    emit({ type: "task_updated", projectId: randomUUID(), taskId: foreignTask });
    emit({ type: "task_updated", projectId: f.project.id, taskId: task.id, attributes: { forbidden: "synthetic-body-marker" } });
    let visible = "";
    for (let attempt = 0; attempt < 5 && !visible.includes('event: task_updated'); attempt++) visible += decoder.decode((await read(live.reader)).value);
    assert.ok(visible.includes(task.id)); assert.ok(!visible.includes(foreignTask)); assert.ok(!visible.includes("synthetic-body-marker"));
    await f.identity.removeMembership(f.owner.headers, f.project.id, viewer.context.actor.id);
    let ended = false;
    for (let attempt = 0; attempt < 5 && !ended; attempt++) ended = (await read(live.reader)).done ?? false;
    assert.equal(ended, true);
    const reconnect = await stream(f.owner.context, true);
    assert.match(decoder.decode((await read(reconnect.reader)).value), /"resume":"resync"/);
    reconnect.controller.abort();
    const slow = await stream();
    for (let index = 0; index < 200; index++) emit({ type: "task_updated", projectId: f.project.id, taskId: task.id });
    let bytes = 0, chunks = 0;
    for (;;) {
      const result = await read(slow.reader); if (result.done) break;
      bytes += result.value.byteLength; chunks++;
      assert.ok(chunks <= 66 && bytes < 128 * 1024);
    }
    const buffered = await stream();
    const fast = await stream();
    await read(fast.reader);
    let delivered = 0;
    const eventDelayMs: number[] = [];
    for (let index = 0; index < 80; index++) {
      const started = performance.now();
      emit({ type: "task_updated", projectId: f.project.id, taskId: task.id });
      for (;;) {
        const message = await read(fast.reader);
        assert.equal(message.done, false);
        if (decoder.decode(message.value).includes("event: task_updated")) { delivered++; eventDelayMs.push(performance.now() - started); break; }
      }
    }
    let bufferedChunks = 0, bufferedBytes = 0;
    for (;;) {
      const result = await read(buffered.reader); if (result.done) break;
      bufferedChunks++; bufferedBytes += result.value.byteLength;
      assert.ok(bufferedChunks <= 66 && bufferedBytes < 128 * 1024);
    }
    assert.equal(delivered, 80); fast.controller.abort();
    eventDelayMs.sort((a, b) => a - b);
    const workspaceIsolation = await checkWorkspaceIsolation(db, f);
    return { workspaceIsolation, eventDelivery: { samples: eventDelayMs.length, p50Ms: eventDelayMs[39], p95Ms: eventDelayMs[75], maximumMs: eventDelayMs.at(-1),
      scope: "Local synthetic event-to-stream delivery, not browser-visible latency" }, initialResync: true, foreignAndBodyHintsExcluded: true, revokedReaderClosed: true,
      reconnectResync: true, burstEvents: 200, slowReaderClosed: true, retainedChunks: chunks, retainedBytes: bytes, bufferedChunks, bufferedBytes, fastReaderEvents: delivered,
      limits: "Deterministic same-process transport/authority checks;two-process console/recovery suites cover separate fencing cases" };
  } finally { controllers.forEach(controller => controller.abort()); }
}
