import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { createReassessmentDecisionService, createReassessmentGrantService } from "@task-weaver/core";
import type { Database } from "@task-weaver/db";
import { createDb, runMigrations, requirements, apiKeys, workflowOutputs, activityLog } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const url = process.env.TW_REASSESSMENT_E2E_DATABASE_URL;
test("reassessment REST enforces live authority, revisions and revocation", { skip: !url, timeout: 60000 }, async t => {
  const parsed = new URL(url!); assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.pathname, "/tw_reassessment_e2e");
  await runMigrations(url!);
  const db = createDb(url!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, url!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Reviewer" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "member", explicitPermissions: [] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Reviewer", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write"] }] });
  const managerKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Manager", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "project.manage", "audit.read"] }] });
  const managerHeaders = new Headers({ authorization: `Bearer ${managerKey.rawKey}`, "content-type": "application/json" });
  const agentHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" });
  const [requirement] = await db.insert(requirements).values({ projectId: f.project.id, title: "Review", createdBy: f.owner.context.actor.id }).returning();
  const request = (path: string, headers: Headers, body?: object) => f.app.request(`http://127.0.0.1:3001/api/v1/reassessment${path}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const grantInput = { projectId: f.project.id, requirementId: requirement!.id, agentId: agent.id, operations: ["revalidate_evidence"], expiresAt: new Date(Date.now() + 60000).toISOString() };
  assert.notEqual((await request("/grants", f.outsider.headers, grantInput)).status, 201);
  assert.notEqual((await request("/grants", agentHeaders, grantInput)).status, 201);
  const grantResponse = await request("/grants", managerHeaders, grantInput); assert.equal(grantResponse.status, 201, await grantResponse.clone().text());
  const grant = await grantResponse.json() as any;
  const decision = { grantId: grant.id, projectId: f.project.id, requirementId: requirement!.id, expectedRevision: requirement!.planRevision, decision: "accept" as const, evidence: [], rationale: "private rationale", inputsAvailable: false, uncertainExternalEffects: true };
  assert.notEqual((await request("/decisions", f.owner.headers, decision)).status, 201);
  assert.notEqual((await request("/decisions", agentHeaders, { ...decision, expectedRevision: decision.expectedRevision + 1 })).status, 201);
  const [otherRequirement] = await db.insert(requirements).values({ projectId: f.project.id, title: "Other", createdBy: f.owner.context.actor.id }).returning();
  const [output] = await db.insert(workflowOutputs).values({ requirementId: requirement!.id, type: "url", url: "https://example.com/evidence", createdBy: f.owner.context.actor.id, createdByType: "human" }).returning();
  const supported = { ...decision, evidence: [{ outputId: output!.id, rationale: "Reviewed the evidence" }], inputsAvailable: true, uncertainExternalEffects: false };
  assert.notEqual((await request("/decisions", agentHeaders, { ...supported, requirementId: otherRequirement!.id, expectedRevision: otherRequirement!.planRevision })).status, 201);
  const accepted = await request("/decisions", agentHeaders, supported);
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const acceptedBody = await accepted.json() as any;
  assert.equal(acceptedBody.disposition, "accept");
  const [audit] = await db.select().from(activityLog).where(eq(activityLog.id, acceptedBody.id));
  assert.equal(audit!.actorId, agent.id);
  assert.equal(audit!.actorType, "agent");
  assert.deepEqual((audit!.metadata as any).evidence, supported.evidence);
  const apply = { projectId: f.project.id, requirementId: requirement!.id, grantId: grant.id, decisionId: acceptedBody.id };
  await db.update(requirements).set({ evidenceNeedsReview: true }).where(eq(requirements.id, requirement!.id));
  assert.notEqual((await request("/apply", f.owner.headers, apply)).status, 200);
  const applied = await request("/apply", agentHeaders, apply);
  assert.equal(applied.status, 200, await applied.clone().text());
  const [reviewed] = await db.select().from(requirements).where(eq(requirements.id, requirement!.id));
  assert.equal(reviewed!.evidenceNeedsReview, false);
  const [applicationAudit] = await db.select().from(activityLog).where(eq(activityLog.action, "agent_reassessment_applied"));
  assert.equal(applicationAudit!.actorId, agent.id); assert.equal(applicationAudit!.actorType, "agent");
  assert.equal((applicationAudit!.metadata as any).decisionId, acceptedBody.id);
  await db.update(requirements).set({ evidenceNeedsReview: true }).where(eq(requirements.id, requirement!.id));
  const waitForBlocked = async () => {
    for (let i = 0; i < 200; i++) {
      const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0 limit 1`);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Competing transaction did not block");
  };
  let revisionLocked!: () => void, releaseRevision!: () => void;
  const locked = new Promise<void>(resolve => { revisionLocked = resolve; });
  const release = new Promise<void>(resolve => { releaseRevision = resolve; });
  const changeRevision = db.transaction(async tx => {
    await tx.update(requirements).set({ planRevision: requirement!.planRevision + 1 }).where(eq(requirements.id, requirement!.id));
    revisionLocked(); await release;
  });
  await locked;
  const concurrentApply = request("/apply", agentHeaders, apply);
  try { await waitForBlocked(); } finally { releaseRevision(); }
  await changeRevision;
  assert.equal((await concurrentApply).status, 409);
  await db.update(requirements).set({ planRevision: requirement!.planRevision }).where(eq(requirements.id, requirement!.id));
  await db.update(workflowOutputs).set({ availability: "missing" }).where(eq(workflowOutputs.id, output!.id));
  assert.notEqual((await request("/apply", agentHeaders, apply)).status, 200);
  const missing = await request("/decisions", agentHeaders, supported);
  assert.equal(missing.status, 201);
  const missingBody = await missing.json() as any;
  assert.equal(missingBody.disposition, "escalate");
  assert.notEqual((await request("/apply", agentHeaders, { ...apply, decisionId: missingBody.id })).status, 200);
  await db.update(requirements).set({ planRevision: requirement!.planRevision + 1 }).where(eq(requirements.id, requirement!.id));
  assert.equal((await request("/decisions", agentHeaders, supported)).status, 409);
  assert.equal((await request("/apply", agentHeaders, apply)).status, 409);
  await db.update(requirements).set({ planRevision: requirement!.planRevision }).where(eq(requirements.id, requirement!.id));
  const recorded = await request("/decisions", agentHeaders, decision); assert.equal(recorded.status, 201); assert.equal((await recorded.json() as any).disposition, "escalate");
  const inspected = await request(`/decisions?requirementId=${requirement!.id}`, agentHeaders); assert.equal(inspected.status, 200); assert.doesNotMatch(await inspected.text(), /private rationale/);
  assert.notEqual((await request(`/decisions?requirementId=${requirement!.id}`, f.outsider.headers)).status, 200);
  const activity = await f.app.request(`http://127.0.0.1:3001/api/v1/activity?projectId=${f.project.id}&action=agent_reassessment_recorded`, { headers: managerHeaders });
  assert.equal(activity.status, 200); assert.doesNotMatch(await activity.text(), /private rationale/);
  // Keep the actual service transaction open after apply/revoke, then prove the
  // competing service is waiting on a PostgreSQL lock before committing it.
  const agentContext = await f.auth.resolve(agentHeaders);
  const managerContext = await f.auth.resolve(managerHeaders);
  const decisions = createReassessmentDecisionService(agentContext);
  const grants = createReassessmentGrantService(managerContext);
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
  };
  await db.update(workflowOutputs).set({ availability: "available" }).where(eq(workflowOutputs.id, output!.id));
  const fresh = await request("/decisions", agentHeaders, supported);
  assert.equal(fresh.status, 201);
  const freshDecision = await fresh.json() as any;
  const freshApply = { ...apply, decisionId: freshDecision.id };
  // Commit evidence changes while apply is waiting, then check that its
  // snapshot cannot clear review. A rolled-back change must leave it usable.
  const raceEvidence = async (change: (tx: Database) => Promise<void>, rollback = false) => {
    const changed = gate(), finish = gate();
    const mutation = db.transaction(async tx => {
      await change(tx as unknown as Database);
      changed.open(); await finish.promise;
      if (rollback) throw new Error("intentional rollback");
    });
    const settledMutation = rollback ? assert.rejects(mutation, /intentional rollback/) : mutation;
    await changed.promise;
    const pending = decisions.apply(db, freshApply);
    const outcome = pending.then(() => true, () => false);
    try { await waitForBlocked(); } finally { finish.open(); }
    await settledMutation;
    assert.equal(await outcome, rollback);
    const [state] = await db.select().from(requirements).where(eq(requirements.id, requirement!.id));
    assert.equal(state!.evidenceNeedsReview, !rollback);
    if (rollback) await db.update(requirements).set({ evidenceNeedsReview: true }).where(eq(requirements.id, requirement!.id));
  };
  await raceEvidence(async tx => { await tx.update(workflowOutputs).set({ availability: "missing" }).where(eq(workflowOutputs.id, output!.id)); });
  await db.update(workflowOutputs).set({ availability: "available" }).where(eq(workflowOutputs.id, output!.id));
  await raceEvidence(async tx => { await tx.delete(workflowOutputs).where(eq(workflowOutputs.id, output!.id)); });
  await db.insert(workflowOutputs).values(output!);
  await raceEvidence(async tx => { await tx.update(workflowOutputs).set({ availability: "missing" }).where(eq(workflowOutputs.id, output!.id)); }, true);
  // An uncommitted insertion holds a foreign-key lock on the requirement;
  // apply must wait for it and then observe the additional output.
  let insertedId = "";
  await raceEvidence(async tx => {
    const [inserted] = await tx.insert(workflowOutputs).values({ requirementId: requirement!.id, type: "comment", createdBy: f.owner.context.actor.id, createdByType: "human" }).returning();
    insertedId = inserted!.id;
  });
  await db.delete(workflowOutputs).where(eq(workflowOutputs.id, insertedId));
  const appliedGate = gate(), commitApply = gate();
  const first = db.transaction(async tx => {
    await decisions.apply(tx as unknown as Database, freshApply);
    appliedGate.open(); await commitApply.promise;
  });
  await appliedGate.promise;
  const revokeAfter = grants.revoke(db, f.project.id, grant.id);
  try { await waitForBlocked(); } finally { commitApply.open(); }
  await first; await revokeAfter;
  assert.equal((await db.select().from(requirements).where(eq(requirements.id, requirement!.id)))[0]!.evidenceNeedsReview, false);

  const secondGrant = await grants.create(db, { ...grantInput, operations: ["revalidate_evidence"], expiresAt: new Date(grantInput.expiresAt) });
  await db.update(requirements).set({ evidenceNeedsReview: true }).where(eq(requirements.id, requirement!.id));
  const secondDecision = await decisions.record(db, { ...supported, grantId: secondGrant.id });
  const revokedGate = gate(), commitRevoke = gate();
  const second = db.transaction(async tx => {
    await grants.revoke(tx as unknown as Database, f.project.id, secondGrant.id);
    revokedGate.open(); await commitRevoke.promise;
  });
  await revokedGate.promise;
  const applyAfter = decisions.apply(db, { ...apply, grantId: secondGrant.id, decisionId: secondDecision.id });
  // Attach rejection handling immediately while the transaction is blocked.
  const rejectedApply = assert.rejects(applyAfter);
  try { await waitForBlocked(); } finally { commitRevoke.open(); }
  await second; await rejectedApply;
  assert.equal((await db.select().from(requirements).where(eq(requirements.id, requirement!.id)))[0]!.evidenceNeedsReview, true);
  assert.notEqual((await request("/decisions", agentHeaders, decision)).status, 201);
  assert.notEqual((await request("/apply", agentHeaders, apply)).status, 200);
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.id));
  assert.notEqual((await request(`/decisions?requirementId=${requirement!.id}`, agentHeaders)).status, 200);
});
