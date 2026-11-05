import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDb } from "@task-weaver/db";
import { appendDurableEvent, replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint, type EventAuthorization } from "./durable-events";

const url = process.env.TW_EVENT_E2E_DATABASE_URL;
test("durable append, replay and checkpoints", { skip: !url }, async () => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/tw_event_e2e");
  const db = createDb(url!, { maxConnections: 5 });
  const client = db.$client;
  const projectId = "00000000-0000-4000-8000-000000000001";
  const auth: EventAuthorization = { principal: { id: "one", type: "agent" }, project: async () => {}, consumer: async () => {}, event: async row => row.type !== "hidden" };
  const input = (id: string, type = "visible") => ({ id, projectId, type, version: 1, scope: {}, payload: { b: 2, a: 1 }, occurredAt: new Date("2026-01-01T00:00:00Z") });
  try {
    await client.unsafe("CREATE SCHEMA task_weaver; CREATE TABLE task_weaver.projects (id uuid PRIMARY KEY)");
    const migration = await readFile(new URL("../../../db/drizzle/0085_durable_events.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await client.unsafe(statement);
    const binding = await readFile(new URL("../../../db/drizzle/0086_event_consumer_principals.sql", import.meta.url), "utf8");
    for (const statement of binding.split("--> statement-breakpoint")) await client.unsafe(statement);
    await client`INSERT INTO task_weaver.projects VALUES (${projectId})`;
    const first = input("00000000-0000-4000-8000-000000000011");
    await assert.rejects(db.transaction(async tx => { await appendDurableEvent(tx, first); throw new Error("rollback"); }));
    const [a, b] = await Promise.all([db.transaction(tx => appendDurableEvent(tx, first)), db.transaction(tx => appendDurableEvent(tx, first))]);
    assert.equal(a.sequence, 1n); assert.equal(b.sequence, 1n);
    await assert.rejects(db.transaction(tx => appendDurableEvent(tx, { ...first, type: "conflict" })));
    await db.transaction(tx => appendDurableEvent(tx, input("00000000-0000-4000-8000-000000000012", "hidden")));
    const batch = await replayDurableEvents(db, { projectId, cursor: "0", limit: 2 }, auth);
    assert.equal(batch.status, "valid");
    if (batch.status === "valid") { assert.equal(batch.cursor, "2"); assert.deepEqual(batch.events.map(e => e.sequence), ["1"]); }
    await assert.rejects(replayDurableEvents(db, { projectId, cursor: "3" }, auth));
    await assert.rejects(replayDurableEvents(db, { projectId, cursor: "01" }, auth));
    await acknowledgeDurableEvents(db, { projectId, consumer: "worker", cursor: "2" }, auth);
    await acknowledgeDurableEvents(db, { projectId, consumer: "worker", cursor: "1" }, auth);
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, auth)).cursor, "2");
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "other" }, auth)).cursor, "0");
    await assert.rejects(getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, { ...auth, consumer: async () => { throw new Error("revoked"); } }));
    const other = { ...auth, principal: { id: "two", type: "agent" as const } };
    const sameIdOtherType = { ...auth, principal: { id: "one", type: "human" as const } };
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, other)).cursor, "0");
    await acknowledgeDurableEvents(db, { projectId, consumer: "worker", cursor: "1" }, other);
    await acknowledgeDurableEvents(db, { projectId, consumer: "worker", cursor: "1" }, sameIdOtherType);
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, auth)).cursor, "2");
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, other)).cursor, "1");
    assert.equal((await getDurableEventCheckpoint(db, { projectId, consumer: "worker" }, sameIdOtherType)).cursor, "1");
    let checks = 0;
    const revoked = await replayDurableEvents(db, { projectId, cursor: "0" }, { ...auth, event: async row => row.type !== "hidden" && ++checks === 1 });
    assert.equal(revoked.status, "valid");
    if (revoked.status === "valid") assert.deepEqual(revoked.events, []);
    await client`UPDATE task_weaver.event_streams SET retention_floor = 1 WHERE project_id = ${projectId}`;
    assert.equal((await replayDurableEvents(db, { projectId, cursor: "0" }, auth)).status, "expired");
  } finally {
    await client.unsafe("DROP SCHEMA IF EXISTS task_weaver CASCADE");
    await client.end();
  }
});
