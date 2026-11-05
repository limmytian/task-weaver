import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, authActors, authUsers, authSessions, projects, projectMemberships, requirements } from "@task-weaver/db";
import { requestIdentitySnapshotSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { appendDurableEvent, replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint } from "./durable-events";

const url = process.env.TW_EVENT_E2E_DATABASE_URL;
test("live event authorization and principal-owned checkpoints", { skip: !url, timeout: 60000 }, async t => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/tw_event_e2e");
  await runMigrations(url!);
  const db = createDb(url!);
  t.after(() => db.$client.end());
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
  await append("plan.changed", { requirementId: requirement!.id });
  await append("plan.changed", { requirementId: foreignRequirement!.id });
  await append("plan.changed", { requirementId: requirement!.id, extra: true });
  await append("unknown", { requirementId: requirement!.id });
  const batch = await replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context);
  assert.equal(batch.status, "valid");
  if (batch.status === "valid") { assert.equal(batch.cursor, "4"); assert.deepEqual(batch.events.map(e => e.sequence), ["1"]); }
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, other.context));
  await acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "4" }, owner.context);
  await db.insert(projectMemberships).values({ projectId: project!.id, actorId: other.actor.id, actorType: "human", role: "viewer" });
  assert.equal((await getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, other.context)).cursor, "0");
  await db.delete(authSessions).where(eq(authSessions.id, other.session.id));
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, other.context));
  await assert.rejects(getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, other.context));
  await db.delete(requirements).where(eq(requirements.id, requirement!.id));
  const deleted = await replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context);
  if (deleted.status === "valid") assert.deepEqual(deleted.events, []); else assert.fail("unexpected expiration");
  await db.update(projectMemberships).set({ removedAt: new Date() }).where(eq(projectMemberships.id, membership!.id));
  await assert.rejects(replayDurableEvents(db, { projectId: project!.id, cursor: "0" }, owner.context));
  await assert.rejects(acknowledgeDurableEvents(db, { projectId: project!.id, consumer: "worker", cursor: "4" }, owner.context));
  await assert.rejects(getDurableEventCheckpoint(db, { projectId: project!.id, consumer: "worker" }, owner.context));
});
