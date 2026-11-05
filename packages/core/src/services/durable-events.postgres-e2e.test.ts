import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, runMigrations, authActors, authUsers, authSessions, projects, projectMemberships, requirements, eventStreams, durableEvents } from "@task-weaver/db";
import { requestIdentitySnapshotSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { appendDurableEvent, replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint } from "./durable-events";

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
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context));
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "16" }, owner.context));
  await assert.rejects(getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, owner.context));
});
