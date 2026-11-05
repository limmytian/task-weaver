import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.TW_EVENT_E2E_DATABASE_URL;
test("durable event migration enforces project-local identities and bounds", { skip: !url }, async () => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/tw_event_e2e");
  const db = postgres(url!, { max: 1 });
  try {
    await db.begin(async tx => {
      await tx.unsafe('CREATE SCHEMA task_weaver; CREATE TABLE task_weaver.projects (id uuid PRIMARY KEY)');
      const migration = await readFile(new URL("../drizzle/0085_durable_events.sql", import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
      const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
      await tx.unsafe(`INSERT INTO task_weaver.projects VALUES ('${a}'), ('${b}')`);
      await tx.unsafe(`INSERT INTO task_weaver.event_streams (project_id) VALUES ('${a}'), ('${b}')`);
      await tx.unsafe(`INSERT INTO task_weaver.durable_events (project_id, sequence, type, version, scope, payload, occurred_at) VALUES ('${a}', 1, 'example', 1, '{}', '{}', now()), ('${b}', 1, 'other', 2, '{}', '{}', now())`);
      await tx.unsafe(`INSERT INTO task_weaver.event_consumers (project_id, name) VALUES ('${a}', 'worker'), ('${b}', 'worker')`);
      const binding = await readFile(new URL("../drizzle/0086_event_consumer_principals.sql", import.meta.url), "utf8");
      for (const statement of binding.split("--> statement-breakpoint")) await tx.unsafe(statement);
      assert.equal((await tx.unsafe<{ count: number }[]>("SELECT count(*)::int AS count FROM task_weaver.event_consumers"))[0]!.count, 0);
      await tx.unsafe(`INSERT INTO task_weaver.event_consumers (project_id, principal_type, principal_id, name) VALUES ('${a}', 'agent', 'one', 'worker'), ('${a}', 'agent', 'two', 'worker'), ('${b}', 'agent', 'one', 'worker')`);
      await assert.rejects(tx.savepoint(s => s.unsafe(`INSERT INTO task_weaver.event_consumers (project_id, principal_type, principal_id, name) VALUES ('${a}', 'agent', 'one', 'worker')`)));
      await assert.rejects(tx.savepoint(s => s.unsafe(`INSERT INTO task_weaver.durable_events (project_id, sequence, type, version, scope, payload, occurred_at) VALUES ('${a}', 1, 'duplicate', 1, '{}', '{}', now())`)));
      await assert.rejects(tx.savepoint(s => s.unsafe(`UPDATE task_weaver.event_streams SET retention_floor = 1 WHERE project_id = '${a}'`)));
      await assert.rejects(tx.savepoint(s => s.unsafe(`UPDATE task_weaver.event_consumers SET acknowledged_sequence = -1 WHERE project_id = '${a}'`)));
      await assert.rejects(tx.savepoint(s => s.unsafe(`INSERT INTO task_weaver.durable_events (project_id, sequence, type, version, scope, payload, occurred_at) VALUES ('${a}', 2, 'bad', 0, '{}', '{}', now())`)));
      throw new Error("rollback fixture");
    }).catch(error => { if (error.message !== "rollback fixture") throw error; });
  } finally { await db.end(); }
});
