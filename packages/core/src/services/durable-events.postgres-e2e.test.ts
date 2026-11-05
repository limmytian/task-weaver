import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, runMigrations, authActors, authUsers, authSessions, projects, projectMemberships, requirements, eventStreams, durableEvents } from "@task-weaver/db";
import { requestIdentitySnapshotSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { invalidatePlanningExecutions, planningChangeSnapshot } from "./planning-impact";
import { lockIdentityLifecycle } from "./auth-security";
import { appendDurableEvent, replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint, acquireDurableConsumerLease, renewDurableConsumerLease, acknowledgeDurableEventsFenced, recordEventCursorIncident, inspectEventCursorIncidents, resolveEventCursorIncident } from "./durable-events";

const url = process.env.TW_EVENT_E2E_DATABASE_URL;
test("live event authorization and principal-owned checkpoints", { skip: !url, timeout: 60000 }, async t => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/tw_event_e2e");
  await runMigrations(url!);
  const db = createDb(url!);
  t.after(() => db.$client.end());
  async function waitForBlockedTransaction() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await db.$client`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      if (rows[0]!.count > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected transaction to wait on a PostgreSQL lock");
  }
  async function human() {
    const [actor] = await db.insert(authActors).values({ type: "human", displayName: "Event fixture", status: "active" }).returning();
    const [user] = await db.insert(authUsers).values({ actorId: actor!.id, name: "Event fixture", email: `${randomUUID()}@example.test`, status: "active", instanceRole: "user" }).returning();
    const now = new Date(), expires = new Date(now.getTime() + 3600000);
    const [session] = await db.insert(authSessions).values({ userId: user!.id, token: randomUUID(), createdAt: now, expiresAt: expires, absoluteExpiresAt: expires, idleExpiresAt: expires }).returning();
    const context = requestIdentitySnapshotSchema.parse({ actor: { id: actor!.id, type: "human", userId: user!.id, status: "active", instanceRole: "user" }, credential: { id: session!.id, kind: "session", actorId: actor!.id, expiresAt: expires.toISOString() }, verifiedAt: now.toISOString() }) as VerifiedRequestContext;
    return { actor: actor!, session: session!, context };
  }
  const owner = await human(), other = await human();
  const [project] = await db.insert(projects).values({ name: "Event project", createdBy: owner.actor.id }).returning();
  const [foreign] = await db.insert(projects).values({ name: "Foreign project", createdBy: other.actor.id }).returning();
  const [membership] = await db.insert(projectMemberships).values({ projectId: project!.id, actorId: owner.actor.id, actorType: "human", role: "owner" }).returning();
  await db.insert(projectMemberships).values({ projectId: foreign!.id, actorId: other.actor.id, actorType: "human", role: "owner" });
  const [requirement] = await db.insert(requirements).values({ projectId: project!.id, title: "Event requirement", createdBy: owner.actor.id }).returning();
  const [foreignRequirement] = await db.insert(requirements).values({ projectId: foreign!.id, title: "Foreign requirement", createdBy: other.actor.id }).returning();
  // Publishing is atomic with revision changes and independent of a daemon claim.
  await db.transaction(async tx => {
    const txDb = tx as unknown as typeof db;
    const snapshot = await planningChangeSnapshot(txDb, "updateRequirement", [txDb, requirement!.id, { title: "sensitive title", status: "approved" }]);
    await tx.update(requirements).set({ title: "sensitive title", status: "approved" }).where(eq(requirements.id, requirement!.id));
    await invalidatePlanningExecutions(txDb, [requirement!.id], "updateRequirement", [], undefined, snapshot, "approved");
    await invalidatePlanningExecutions(tx as unknown as typeof db, [requirement!.id], "updateRequirement");
  });
  const published = await db.select().from(durableEvents).where(eq(durableEvents.projectId, project!.id)).orderBy(durableEvents.sequence);
  assert.deepEqual(published.map(event => [event.type, event.payload.oldRevision, event.payload.newRevision]), [["plan.changed", 0, 1], ["plan.changed", 1, 2]]);
  assert.deepEqual(published[0]!.payload.changedFields, { status: "available", fields: ["title", "status"] });
  assert.deepEqual(published[0]!.payload.before, { status: "available", values: { status: "draft" } });
  assert.deepEqual(published[0]!.payload.after, { status: "available", values: { status: "approved" } });
  assert.ok(!JSON.stringify(published[0]!.payload).includes("sensitive title"));
  await assert.rejects(db.transaction(async tx => {
    await invalidatePlanningExecutions(tx as unknown as typeof db, [requirement!.id], "updateRequirement");
    throw new Error("rollback plan");
  }), /rollback plan/);
  assert.equal((await db.select().from(durableEvents).where(eq(durableEvents.projectId, project!.id))).length, 2);
  // Reset this fixture's stream before the independent cursor tests below.
  await db.delete(durableEvents).where(eq(durableEvents.projectId, project!.id));
  await db.delete(eventStreams).where(eq(eventStreams.projectId, project!.id));
  const append = (type: string, scope: Record<string, unknown>) => db.transaction(tx => appendDurableEvent(tx, { id: randomUUID(), projectId: project!.id, type, version: 1, scope, payload: {}, occurredAt: new Date() }));
  // Distinct concurrent writers must allocate a contiguous sequence, including
  // when the stream row does not yet exist.
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => append("plan.changed", { requirementId: requirement!.id })));
  assert.deepEqual(concurrent.map(e => Number(e.sequence)).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  const id = randomUUID(), occurredAt = new Date();
  const input = { id, projectId: project!.id, type: "plan.changed", version: 1, scope: { requirementId: requirement!.id }, payload: {}, occurredAt };
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => db.transaction(tx => appendDurableEvent(tx, input))));
  assert.deepEqual(new Set(duplicates.map(e => e.sequence)), new Set([13n]));
  await assert.rejects(db.transaction(tx => appendDurableEvent(tx, { ...input, payload: { changed: true } })), /conflicts/);
  await assert.rejects(db.transaction(async tx => { await appendDurableEvent(tx, { ...input, id: randomUUID() }); throw new Error("rollback append"); }), /rollback append/);
  assert.equal((await append("plan.changed", { requirementId: foreignRequirement!.id })).sequence, 14n);
  await append("plan.changed", { requirementId: requirement!.id, extra: true });
  await append("unknown", { requirementId: requirement!.id });
  const batch = await replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context);
  assert.equal(batch.status, "valid");
  if (batch.status === "valid") { assert.equal(batch.cursor, "16"); assert.deepEqual(batch.events.map(e => e.sequence), Array.from({ length: 13 }, (_, i) => String(i + 1))); }
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, other.context));
  // A disconnected consumer resumes from its last acknowledged position; an
  // unacknowledged batch can be delivered again after a new connection.
  const firstBatch = await replayDurableEvents(db, { projectId: project!.id, cursor: "0", limit: 5 }, owner.context);
  assert.equal(firstBatch.status, "valid");
  const reconnect = createDb(url!);
  try {
    const replayed = await replayDurableEvents(reconnect, { projectId: project!.id, cursor: "0", limit: 5 }, owner.context);
    assert.deepEqual(replayed, firstBatch);
    assert.equal((await acknowledgeDurableEvents(reconnect, { projectId: project!.id, consumer: "worker", cursor: "5" }, owner.context)).cursor, "5");
    assert.equal((await acknowledgeDurableEvents(reconnect, { projectId: project!.id, consumer: "worker", cursor: "5" }, owner.context)).cursor, "5");
  } finally { await reconnect.$client.end(); }
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, owner.context)).cursor, "5");
  const resumed = await replayDurableEvents(db, { projectId: project!.id, cursor: "5", limit: 5 }, owner.context);
  assert.equal(resumed.status, "valid");
  if (resumed.status === "valid") assert.deepEqual(resumed.events.map(e => e.sequence), ["6", "7", "8", "9", "10"]);
  await acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "16" }, owner.context);
  await db.insert(projectMemberships).values({ projectId: project!.id, actorId: other.actor.id, actorType: "human", role: "viewer" });
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, other.context)).cursor, "0");
  await acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "2" }, other.context);
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, owner.context)).cursor, "16");
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, other.context)).cursor, "2");
  assert.equal((await acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "1" }, other.context)).cursor, "2");
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "17" }, owner.context), /ahead/);
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "17" }, owner.context), /ahead/);
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "-1" }, owner.context));

  // Concurrent contenders serialize on the named principal-owned lease.
  const leaseOwner = randomUUID(), rival = randomUUID();
  const leaseInput = { projectId: project!.id, consumer: "leased", owner: leaseOwner, durationMs: 30000 };
  const contenders = await Promise.all([acquireDurableConsumerLease(db, leaseInput, owner.context), acquireDurableConsumerLease(db, { ...leaseInput, owner: rival }, owner.context)]);
  assert.equal(contenders.filter(result => result.status === "acquired").length, 1);
  const winner = contenders[0]!.status === "acquired" ? leaseOwner : rival;
  const acquired = contenders.find(result => result.status === "acquired")!;
  if (acquired.status !== "acquired") throw new Error("Missing lease");
  const fence = { projectId: project!.id, consumer: "leased", owner: winner, generation: acquired.generation };
  assert.equal((await renewDurableConsumerLease(db, { ...fence, durationMs: 30000 }, owner.context)).generation, acquired.generation);
  assert.equal((await acknowledgeDurableEventsFenced(db, { ...fence, cursor: "5" }, owner.context)).cursor, "5");
  await assert.rejects(acknowledgeDurableEventsFenced(db, { ...fence, owner: randomUUID(), cursor: "6" }, owner.context), /stale/);
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "leased", cursor: "6" }, owner.context), /fenced/);
  await db.execute(sql`UPDATE task_weaver.event_consumers SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE project_id = ${project!.id} AND name = 'leased'`);
  await assert.rejects(renewDurableConsumerLease(db, { ...fence, durationMs: 30000 }, owner.context), /stale/);
  await assert.rejects(acknowledgeDurableEventsFenced(db, { ...fence, cursor: "6" }, owner.context), /stale/);
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "leased", cursor: "6" }, owner.context), /fenced/);
  const [takeover, legacyRace] = await Promise.all([
    acquireDurableConsumerLease(db, { ...leaseInput, owner: rival }, owner.context),
    acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "leased", cursor: "6" }, owner.context).then(() => "accepted", () => "rejected"),
  ]);
  assert.equal(legacyRace, "rejected");
  assert.equal(takeover.status, "acquired");
  if (takeover.status !== "acquired") throw new Error("Missing takeover");
  assert.equal(BigInt(takeover.generation), BigInt(acquired.generation) + 1n);
  await assert.rejects(acknowledgeDurableEventsFenced(db, { ...fence, cursor: "6" }, owner.context), /stale/);
  const restarted = createDb(url!);
  try {
    assert.equal((await getDurableEventCheckpoint(restarted, { projectId: project!.id, consumer: "leased" }, owner.context)).cursor, "5");
    assert.equal((await acquireDurableConsumerLease(restarted, leaseInput, owner.context)).status, "busy");
    assert.equal((await acknowledgeDurableEventsFenced(restarted, { ...fence, owner: rival, generation: takeover.generation, cursor: "6" }, owner.context)).cursor, "6");
  } finally { await restarted.$client.end(); }
  assert.equal((await acquireDurableConsumerLease(db, leaseInput, other.context)).status, "acquired");
  // A retention transaction holding the stream lock must be observed before
  // replay decides whether its cursor is still valid.
  let releaseRetention!: () => void, retentionLocked!: () => void;
  const locked = new Promise<void>(resolve => { retentionLocked = resolve; });
  const release = new Promise<void>(resolve => { releaseRetention = resolve; });
  const retention = db.transaction(async tx => {
    await tx.select().from(eventStreams).where(eq(eventStreams.projectId, project!.id)).for("update");
    retentionLocked(); await release;
    await tx.delete(durableEvents).where(sql`${durableEvents.projectId} = ${project!.id} AND ${durableEvents.sequence} <= 2`);
    await tx.update(eventStreams).set({ retentionFloor: 2n }).where(eq(eventStreams.projectId, project!.id));
  });
  await locked;
  const racingReplay = replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context);
  await waitForBlockedTransaction();
  releaseRetention(); await retention;
  assert.equal((await racingReplay).status, "expired");
  assert.equal((await replayDurableEvents(db, { projectId: project!.id, cursor: "2" }, owner.context)).status, "valid");
  assert.deepEqual(await acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "expired", cursor: "1" }, owner.context), { status: "expired", cursor: "1", retentionFloor: "2" });
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "expired" }, owner.context)).cursor, "0");
  const incidentInput = { projectId: project!.id, consumer: "incident-worker", cursor: "1", retentionFloor: "2" };
  const incidents = await Promise.all(Array.from({ length: 8 }, () => recordEventCursorIncident(db, incidentInput, owner.context)));
  assert.equal(new Set(incidents.map(row => row.id)).size, 1);
  const reopenedDb = createDb(url!);
  try {
    assert.equal((await inspectEventCursorIncidents(reopenedDb, { projectId: project!.id }, owner.context))[0]!.id, incidents[0]!.id);
    assert.deepEqual(await inspectEventCursorIncidents(reopenedDb, { projectId: project!.id }, other.context), []);
    await assert.rejects(inspectEventCursorIncidents(reopenedDb, { projectId: foreign!.id }, owner.context));
    await assert.rejects(resolveEventCursorIncident(reopenedDb, { projectId: project!.id, incidentId: incidents[0]!.id }, other.context));
    assert.equal((await getDurableEventCheckpoint(reopenedDb, { projectId: project!.id, consumer: incidentInput.consumer }, owner.context)).cursor, "0");
    await resolveEventCursorIncident(reopenedDb, { projectId: project!.id, incidentId: incidents[0]!.id }, owner.context);
    await assert.rejects(resolveEventCursorIncident(reopenedDb, { projectId: project!.id, incidentId: incidents[0]!.id }, owner.context));
    assert.notEqual((await recordEventCursorIncident(reopenedDb, incidentInput, owner.context)).id, incidents[0]!.id);
    assert.equal((await getDurableEventCheckpoint(reopenedDb, { projectId: project!.id, consumer: incidentInput.consumer }, owner.context)).cursor, "0");
  } finally { await reopenedDb.$client.end(); }
  let releaseRevocation!: () => void, revocationLocked!: () => void;
  const revocationReady = new Promise<void>(resolve => { revocationLocked = resolve; });
  const revocationRelease = new Promise<void>(resolve => { releaseRevocation = resolve; });
  const revocation = db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    revocationLocked(); await revocationRelease;
    await tx.delete(authSessions).where(eq(authSessions.id, other.session.id));
  });
  await revocationReady;
  const revokedReplay = replayDurableEvents(db, { projectId: project!.id, cursor: "2" }, other.context);
  await waitForBlockedTransaction();
  releaseRevocation(); await revocation;
  await assert.rejects(revokedReplay);
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, other.context));
  await assert.rejects(getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, other.context));
  await db.delete(requirements).where(eq(requirements.id, requirement!.id));
  const deleted = await replayDurableEvents(db, { projectId: project!.id, cursor: "2" }, owner.context);
  if (deleted.status === "valid") assert.deepEqual(deleted.events, []); else assert.fail("unexpected expiration");
  await db.update(projectMemberships).set({ removedAt: new Date() }).where(eq(projectMemberships.id, membership!.id));
  await assert.rejects(inspectEventCursorIncidents(db, { projectId: project!.id }, owner.context));
  await assert.rejects(recordEventCursorIncident(db, incidentInput, owner.context));
  await assert.rejects(resolveEventCursorIncident(db, { projectId: project!.id, incidentId: incidents[0]!.id }, owner.context));
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context));
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "16" }, owner.context));
  await assert.rejects(getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, owner.context));
  await assert.rejects(acquireDurableConsumerLease(db, leaseInput, owner.context));
  await assert.rejects(renewDurableConsumerLease(db, { ...fence, durationMs: 30000 }, owner.context));
  await assert.rejects(acknowledgeDurableEventsFenced(db, { ...fence, cursor: "6" }, owner.context));
});
