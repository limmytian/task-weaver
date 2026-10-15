import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, tasks } from "@task-weaver/db";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const databaseUrl = process.env.TW_WORKFLOW_E2E_DATABASE_URL;

test("workflow REST stages, delivery delegations and explicit artifact locality are enforced", { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_workflow_e2e");
  await runMigrations(databaseUrl!);
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const fixture = await resourcePostgresFixture(db, databaseUrl!);
  const api = (path: string, method = "GET", body?: unknown, headers = fixture.owner.headers) => fixture.app.request(`/api/v1${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (response: Response, expected = 200): Promise<any> => {
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  const create = async (body: Record<string, unknown>) => json(await api(`/projects/${fixture.project.id}/requirements`, "POST", { title: "Workflow fixture", ...body }), 201);
  const advance = (id: string, data: Record<string, unknown>, headers = fixture.owner.headers) => api(`/requirements/${id}/workflow-advance`, "POST", { reason: "Fixture evidence", ...data }, headers);

  const basic = await create({});
  assert.equal(basic.workflow.delivery.method, "none");
  assert.equal(basic.workflowSource, "basic");
  assert.equal((await json(await advance(basic.id, { stage: "delivery", expectedRevision: 0 }))).status, "done");

  const projectDefault = { delivery: { method: "url" }, acceptance: {}, integration: {} };
  await json(await api(`/projects/${fixture.project.id}`, "PATCH", { defaultWorkflow: projectDefault }));
  const inherited = await create({});
  assert.equal(inherited.workflowSource, "project");
  assert.equal(inherited.workflow.delivery.method, "url");
  const batch = await json(await api("/requirements/batch", "POST", { requirements: [{ projectId: fixture.project.id, title: "Batch default" }] }), 201);
  assert.equal(batch[0].workflowSource, "project");
  const plan = { projectId: fixture.project.id, requirements: [{ key: "inherited", title: "Plan default" }, { key: "explicit", title: "Plan override", workflowPreset: "comment" }] };
  const preview = await json(await api("/plans/apply", "POST", { dryRun: true, plan }));
  assert.equal(preview.workflows[0].workflow.delivery.method, "url");
  assert.equal(preview.workflows[1].workflow.delivery.method, "comment");
  const applied = await json(await api("/plans/apply", "POST", { plan }), 201);
  const planned = await json(await api(`/requirements/${applied.refs.requirements[1].id}`));
  assert.equal(planned.workflow.delivery.method, "comment");
  assert.equal((await api("/plans/apply", "POST", { dryRun: true, plan }, fixture.outsider.headers)).status, 404);
  await json(await api(`/projects/${fixture.project.id}`, "PATCH", { defaultWorkflow: null }));

  const manual = await create({ workflow: { delivery: { method: "url" }, acceptance: { mode: "manual", requiredChecks: ["Complete report"], minimumHumanApprovals: 1 }, integration: {} } });
  assert.equal((await advance(manual.id, { stage: "delivery", expectedRevision: 0 })).status, 400);
  const output = await json(await api(`/requirements/${manual.id}/workflow-outputs`, "POST", { type: "url", url: "https://example.test/report" }), 201);
  assert.equal(output.workflowRevision, 1);
  assert.equal((await advance(manual.id, { stage: "delivery", expectedRevision: 0 })).status, 409);
  assert.equal((await api(`/requirements/${manual.id}/workflow-outputs`, "GET", undefined, fixture.outsider.headers)).status, 404);
  assert.equal((await json(await advance(manual.id, { stage: "delivery", expectedRevision: 1 }))).status, "in_review");
  assert.equal((await advance(manual.id, { stage: "acceptance", expectedRevision: 2 })).status, 400);
  const rework = await json(await advance(manual.id, { stage: "acceptance", decision: "changes_requested", expectedRevision: 2 }));
  assert.equal(rework.status, "in_progress");
  const followups = await db.query.tasks.findMany({ where: eq(tasks.requirementId, manual.id) });
  assert.equal(followups.length, 1);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, followups[0]!.id));
  const failedResubmission = await json(await advance(manual.id, { stage: "delivery", decision: "failed", expectedRevision: 3 }));
  assert.equal(failedResubmission.workflowState.delivery, "failed");
  assert.equal(failedResubmission.workflowState.acceptance, "failed");
  await json(await advance(manual.id, { stage: "delivery", decision: "retry", expectedRevision: 4 }));
  const resubmitted = await json(await advance(manual.id, { stage: "delivery", expectedRevision: 5 }));
  assert.equal(resubmitted.status, "in_review");
  assert.equal(resubmitted.workflowState.acceptance, "pending");
  assert.equal((await json(await advance(manual.id, { stage: "acceptance", expectedRevision: 6, checks: [{ name: "Complete report", status: "passed" }] }))).status, "done");

  const agent = await fixture.identity.createAgent(fixture.owner.headers, { displayName: "Workflow executor" });
  await fixture.identity.setMembership(fixture.owner.headers, fixture.project.id, agent.id, { role: "maintainer", explicitPermissions: [] });
  const key = await fixture.identity.issueKey(fixture.owner.headers, agent.id, { name: "Workflow fixture", expiresAt: null, grants: [{ scope: "project", projectId: fixture.project.id, permissions: ["resource.read", "resource.write", "execution.run", "audit.read"] }] });
  const agentHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" });
  const daemonA = randomUUID(), daemonB = randomUUID();
  for (const [id, nodeId] of [[daemonA, "node-a"], [daemonB, "node-b"]]) await json(await api("/daemons/register", "POST", { id, name: "Workflow fixture", nodeId, capabilities: ["codex", "executor:codex", "workflow-agent"], role: "executor" }, agentHeaders), 201);

  const delivery = await create({ status: "approved", workflowPreset: "url" });
  const lane = await json(await api(`/daemons/${daemonA}/apply-requirement`, "POST", { projectId: fixture.project.id, workerIndex: 0 }, agentHeaders));
  assert.equal(lane.requirement.id, delivery.id);
  assert.equal(lane.stage, "delivery");
  assert.equal(lane.task, null);
  const capability = await json(await api(`/daemons/${daemonA}/delegations`, "POST", { requirementId: delivery.id, runId: lane.runId, leaseGeneration: lane.leaseGeneration, workerIndex: 0 }, agentHeaders), 201);
  assert.equal(capability.delegation.purpose, "delivery");
  assert.deepEqual(capability.delegation.taskIds, []);
  const delegated = new Headers({ authorization: `Bearer ${capability.token}`, "content-type": "application/json" });
  await json(await api(`/requirements/${delivery.id}/workflow-outputs`, "POST", { type: "url", url: "https://example.test/delivery" }, delegated), 201);
  assert.equal((await advance(delivery.id, { stage: "delivery", expectedRevision: 1 }, delegated)).status, 403);
  const delivered = await json(await advance(delivery.id, { stage: "delivery", expectedRevision: 1, daemonId: daemonA, leaseGeneration: lane.leaseGeneration }, agentHeaders));
  assert.equal(delivered.status, "done");
  assert.equal((await api("/auth/me", "GET", undefined, delegated)).status, 401);

  const producer = await create({ workflowPreset: "local" });
  const local = await json(await api(`/requirements/${producer.id}/workflow-outputs`, "POST", { type: "local", nodeId: "node-a", relativePath: `${producer.id}/file.bin`, sizeBytes: 42, sha256: "a".repeat(64) }), 201);
  await json(await advance(producer.id, { stage: "delivery", expectedRevision: 1 }));
  const consumer = await create({ status: "approved" });
  const task = await json(await api(`/projects/${fixture.project.id}/tasks`, "POST", { requirementId: consumer.id, title: "Consume local output" }), 201);
  await json(await api(`/requirements/${consumer.id}/workflow-inputs`, "POST", { outputId: local.id, taskId: task.id }), 201);
  assert.equal((await api(`/requirements/${producer.id}/workflow-output-retire`, "POST", { outputId: local.id })).status, 400);
  const cleanup = await json(await api(`/requirements/${producer.id}/workflow-cleanup`));
  assert.equal(cleanup.canCleanupWorktrees, false);
  assert.equal(cleanup.activeConsumers, 1);
  const wrongNode = await json(await api(`/daemons/${daemonB}/apply-requirement`, "POST", { projectId: fixture.project.id, workerIndex: 0 }, agentHeaders));
  assert.equal(wrongNode.requirement, null);
  const rightNode = await json(await api(`/daemons/${daemonA}/apply-requirement`, "POST", { projectId: fixture.project.id, workerIndex: 0 }, agentHeaders));
  assert.equal(rightNode.task.id, task.id);
  await json(await api(`/requirements/${consumer.id}/release`, "POST", { daemonId: daemonA, leaseGeneration: rightNode.leaseGeneration }, agentHeaders));
  await db.update(tasks).set({ status: "todo" }).where(eq(tasks.id, task.id));
  assert.equal((await api(`/requirements/${producer.id}/workflow-output-availability`, "POST", { outputId: local.id, nodeId: "node-a", daemonId: daemonB, availability: "available", reason: "Wrong node" }, agentHeaders)).status, 400);
  await json(await api(`/requirements/${producer.id}/workflow-output-availability`, "POST", { outputId: local.id, nodeId: "node-a", daemonId: daemonA, availability: "missing", reason: "File removed" }, agentHeaders));
  assert.equal((await json(await api(`/daemons/${daemonA}/apply-requirement`, "POST", { projectId: fixture.project.id, workerIndex: 0 }, agentHeaders))).requirement, null);
});
