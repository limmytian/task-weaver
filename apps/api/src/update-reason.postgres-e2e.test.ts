import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { activityLog, createDb, runMigrations } from "@task-weaver/db";
import { createResourceServices, createRequirementSchema } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const databaseUrl = process.env.TW_UPDATE_REASON_E2E_DATABASE_URL;
test("HTTP update reasons persist in audit metadata without weakening mutation guards", { skip: !databaseUrl, timeout: 60_000 }, async t => {
  const url = new URL(databaseUrl!); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_update_reason_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!, { maxConnections: 1 }); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const service = createResourceServices(f.owner.context);
  const requirement = await service.requirementService.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: "Audit fixture" }), f.owner.context.actor);
  const task = await service.taskService.createTask(db, { projectId: f.project.id, requirementId: requirement.id, title: "Audit fixture" }, f.owner.context.actor);
  const patch = (kind: string, id: string, body: unknown, headers = f.owner.headers) => f.app.request(`/api/v1/${kind}/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  const audit = (id: string) => db.select().from(activityLog).where(eq(activityLog.entityId, id));
  const revision = (await service.requirementService.getRequirement(db, requirement.id)).planRevision;
  const changed = await patch("tasks", task.id, { priority: "high", expectedVersion: task.version, reason: "  Review feedback  " });
  assert.equal(changed.status, 200); const changedTask = await changed.json() as typeof task;
  assert.equal(changedTask.priority, "high"); assert.equal(changedTask.status, task.status); assert.ok(!("reason" in changedTask));
  const taskAudit = (await audit(task.id)).find(row => row.action === "updated")!.metadata as Record<string, unknown>;
  assert.equal(taskAudit.reason, "Review feedback"); assert.deepEqual(taskAudit.changes, { priority: "high" });
  assert.equal((await service.requirementService.getRequirement(db, requirement.id)).planRevision, revision);
  const reqChanged = await patch("requirements", requirement.id, { status: "approved", reason: "Owner approved scope" });
  assert.equal(reqChanged.status, 200); assert.ok(!("reason" in await reqChanged.json()));
  const reqAudit = (await audit(requirement.id)).find(row => row.action === "status_changed")!.metadata as Record<string, unknown>;
  assert.equal(reqAudit.reason, "Owner approved scope"); assert.deepEqual(reqAudit.changes, { status: "approved" });
  const approved = await service.requirementService.getRequirement(db, requirement.id);
  assert.ok(approved.planRevision >= revision);
  const beforeReasonOnlyRevision = approved.planRevision;
  assert.equal((await patch("requirements", requirement.id, { reason: "Audit note only" })).status, 200);
  assert.equal((await service.requirementService.getRequirement(db, requirement.id)).planRevision, beforeReasonOnlyRevision);
  // Missing reasons preserve old payloads and audit shape.
  assert.equal((await patch("tasks", task.id, { priority: "low" })).status, 200);
  assert.equal((await patch("requirements", requirement.id, { priority: "low" })).status, 200);
  assert.ok((await audit(task.id)).some(row => row.action === "updated" && !Object.hasOwn(row.metadata!, "reason")));
  assert.ok((await audit(requirement.id)).some(row => row.action === "updated" && !Object.hasOwn(row.metadata!, "reason")));
  const taskBefore = (await audit(task.id)).length, reqBefore = (await audit(requirement.id)).length;
  for (const reason of ["   ", "x".repeat(2001), 7, null]) {
    assert.equal((await patch("tasks", task.id, { priority: "high", reason })).status, 400);
    assert.equal((await patch("requirements", requirement.id, { priority: "high", reason })).status, 400);
  }
  assert.equal((await patch("tasks", task.id, { priority: "high", expectedVersion: task.version, reason: "Stale writer" })).status, 409);
  assert.equal((await patch("requirements", requirement.id, { status: "done", reason: "Do not bypass workflow" })).status, 400);
  assert.ok([403, 404].includes((await patch("tasks", task.id, { title: "Denied", reason: "Foreign actor" }, f.outsider.headers)).status));
  assert.ok([403, 404].includes((await patch("requirements", requirement.id, { title: "Denied", reason: "Foreign actor" }, f.outsider.headers)).status));
  assert.equal((await audit(task.id)).length, taskBefore); assert.equal((await audit(requirement.id)).length, reqBefore);
});
