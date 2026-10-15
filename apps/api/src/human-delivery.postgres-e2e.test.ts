import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, activityLog, requirements } from "@task-weaver/db";
import { eq } from "drizzle-orm";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
const databaseUrl = process.env.TW_HUMAN_DELIVERY_E2E_DATABASE_URL;
test("human PR reconciliation verifies server evidence, authority, leases, retries and completion", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_human_delivery_e2e");
  await runMigrations(databaseUrl!); const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const api = (path: string, method = "GET", body?: unknown, headers = f.owner.headers) => f.app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (response: Response, status = 200): Promise<any> => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
  const repo = await json(await api("/repositories", "POST", { host: "github.com", namespace: "acme", name: "app", provider: "github", visibility: "private", ownerId: f.owner.context.actor.id, ownerType: "human", defaultBranch: "main" }), 201);
  const create = async (workflow?: unknown) => {
    const r = await json(await api(`/projects/${f.project.id}/requirements`, "POST", { title: "Human PR", status: "approved", ...(workflow ? { workflow } : {}) }), 201);
    const link = await json(await api(`/requirements/${r.id}/repositories`, "POST", { repositoryId: repo.id, baseBranch: "main", workingBranch: "feature" }), 201);
    return { r, link };
  };
  const initial = await create();
  // A historical requirement retains its legacy completion guard.
  await db.update(requirements).set({ workflow: null, workflowSource: null }).where(eq(requirements.id, initial.r.id));
  let current = initial.link;
  let row = { number: 12, html_url: "https://github.com/acme/app/pull/12", state: "open", merged: false, merged_at: null as string | null, merge_commit_sha: null as string | null, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/app" } } };
  const originalFetch = globalThis.fetch; let reads = 0;
  globalThis.fetch = async (path, options) => { assert.equal(String(path), "https://api.github.com/repos/acme/app/pulls/12"); assert.equal(options?.redirect, "error"); reads++; return Response.json(row); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = () => ({ pullRequestUrl: row.html_url, reason: "Synchronize externally delivered PR", expectedRevision: current.externalSyncRevision, expectedUpdatedAt: current.updatedAt, idempotencyKey: randomUUID() });
  const sync = (body = input(), headers = f.owner.headers) => api(`/requirement-repositories/${current.id}/human-sync`, "POST", body, headers);
  assert.equal((await sync(input(), f.outsider.headers)).status, 404); assert.equal(reads, 0);
  assert.equal((await sync({ ...input(), snapshot: row } as any)).status, 400);
  assert.equal((await sync({ ...input(), pullRequestUrl: "https://github.com/evil/app/pull/12" })).status, 400);
  assert.equal((await sync({ ...input(), expectedRevision: 99 })).status, 409);
  row.base.ref = "other"; assert.equal((await sync()).status, 400); row.base.ref = "main";
  const concurrentRequests = [input(), input()];
  const concurrent = await Promise.all(concurrentRequests.map(body => sync(body)));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const successIndex = concurrent.findIndex(response => response.status === 200);
  const openRequest = concurrentRequests[successIndex]!;
  const open = await json(concurrent[successIndex]!); current = open.link;
  assert.equal(current.deliveryStatus, "in_review"); assert.equal(current.reviewStatus, "pending");
  const incomplete = await json(await api(`/requirements/${initial.r.id}`, "PATCH", { status: "done" }), 400);
  assert.match(incomplete.error, /every repository delivery/);
  assert.equal(incomplete.code, "requirement_validation_failed");
  const limitedKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "No project management", expiresAt: null, grants: [
    { scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "repository.manage"] },
    { scope: "personal", actorId: f.owner.context.actor.id, permissions: ["resource.read"] },
  ] });
  assert.equal((await sync(input(), new Headers({ authorization: `Bearer ${limitedKey.rawKey}`, "content-type": "application/json" }))).status, 403);
  const beforeRetryReads = reads; assert.equal((await json(await sync(openRequest))).idempotent, true); assert.equal(reads, beforeRetryReads);
  assert.equal((await sync({ ...openRequest, reason: "Different request" })).status, 409);
  assert.equal((await sync({ ...input(), expectedUpdatedAt: initial.link.updatedAt })).status, 409);
  row.state = "closed"; current = (await json(await sync())).link; assert.equal(current.deliveryStatus, "failed");
  row.state = "open"; current = (await json(await sync())).link; assert.equal(current.deliveryStatus, "in_review");
  row.head.sha = "d".repeat(40); assert.equal((await sync()).status, 409); row.head.sha = "a".repeat(40);
  await json(await api(`/requirements/${initial.r.id}/claim`, "POST", { durationMinutes: 5 }, f.owner.headers), 201);
  await f.identity.setMembership(f.owner.headers, f.project.id, f.outsider.context.actor.id, { role: "maintainer", explicitPermissions: [] });
  await json(await api(`/requirements/${initial.r.id}/release`, "POST", { reason: "Continue reconciliation" }));
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Daemon regression" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: [] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "execution.run", "repository.manage", "project.manage"] }, { scope: "personal", actorId: f.owner.context.actor.id, permissions: ["resource.read"] }] });
  const agentHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" });
  assert.equal((await sync(input(), agentHeaders)).status, 403);
  const daemonId = randomUUID(); await json(await api("/daemons/register", "POST", { id: daemonId, name: "Fixture", role: "executor", capabilities: ["codex"] }, agentHeaders), 201);
  await json(await api(`/requirements/${initial.r.id}/claim`, "POST", { daemonId, workerIndex: 0, durationMinutes: 5 }, agentHeaders), 201);
  assert.equal((await sync()).status, 409);
  const active = await json(await api(`/requirements/${initial.r.id}/claim`));
  await json(await api(`/requirements/${initial.r.id}/release`, "POST", { daemonId, leaseGeneration: active.generation }, agentHeaders));
  row.state = "closed"; row.merged = true; row.merged_at = "2026-10-15T10:00:00Z"; row.merge_commit_sha = "c".repeat(40);
  const mergedRequest = input(); const merged = await json(await sync(mergedRequest)); current = merged.link;
  assert.equal(current.deliveryStatus, "merged"); assert.equal(current.reviewStatus, "pending"); assert.equal(current.mergerActorType, "human"); assert.equal(current.mergerDaemonId, null); assert.equal(current.externalState.mergeCommit, row.merge_commit_sha);
  assert.equal((await json(await api(`/requirements/${initial.r.id}`, "PATCH", { status: "done" }))).status, "done");
  assert.equal((await json(await sync(mergedRequest))).idempotent, true); assert.equal((await sync()).status, 400);
  const audit = await db.query.activityLog.findMany({ where: eq(activityLog.entityId, initial.r.id) });
  assert.equal(audit.filter(a => a.action === "repository_delivery_human_reconciled").length, 4);
  const workflow = await create({ delivery: { method: "git_pr" }, acceptance: { mode: "manual" }, integration: { mode: "manual", method: "git_provider" } });
  current = workflow.link; await json(await sync());
  const unchanged = await json(await api(`/requirements/${workflow.r.id}`)); assert.equal(unchanged.status, "approved"); assert.equal(unchanged.workflowState.acceptance, "pending");
  assert.equal(unchanged.workflowOutputs[0].headCommit, row.head.sha);
  const workflowIncomplete = await json(await api(`/requirements/${workflow.r.id}`, "PATCH", { status: "done" }), 400);
  assert.equal(workflowIncomplete.error, "Requirement workflow stages are not complete");
  let stateRevision = unchanged.workflowStateRevision;
  for (const stage of ["delivery", "acceptance", "integration"]) {
    const advanced = await json(await api(`/requirements/${workflow.r.id}/workflow-advance`, "POST", { stage, expectedRevision: stateRevision, reason: "Human verified configured stage" }));
    stateRevision = advanced.workflowStateRevision;
    if (stage === "integration") assert.equal(advanced.status, "done");
  }
  assert.equal((await api(`/requirement-repositories/${current.id}/forge-sync`, "POST", { snapshot: row })).status, 400);
});
