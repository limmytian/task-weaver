import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, requirements, apiKeys } from '@task-weaver/db';
import { resourcePostgresFixture } from './resource-postgres-fixture';

const databaseUrl = process.env.TW_EXECUTION_RECOVERY_E2E_DATABASE_URL;
test('managed child observations are fenced and reject replay', { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/tw_execution_recovery_e2e');
  await runMigrations(databaseUrl!);
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const fixture = await resourcePostgresFixture(db, databaseUrl!);
  const api = (path: string, method = 'GET', body?: unknown, headers = fixture.owner.headers) => fixture.app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (response: Response, expected = 200): Promise<any> => { assert.equal(response.status, expected, await response.clone().text()); return response.json(); };
  const agent = await fixture.identity.createAgent(fixture.owner.headers, { displayName: 'Recovery executor' });
  await fixture.identity.setMembership(fixture.owner.headers, fixture.project.id, agent.id, { role: 'maintainer', explicitPermissions: [] });
  const key = await fixture.identity.issueKey(fixture.owner.headers, agent.id, { name: 'Recovery test', expiresAt: null, grants: [{ scope: 'project', projectId: fixture.project.id, permissions: ['resource.read', 'resource.write', 'execution.run', 'audit.read'] }, { scope: 'personal', actorId: fixture.owner.context.actor.id, permissions: ['resource.read'] }] });
  const agentHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' });
  const otherKey = await fixture.identity.issueKey(fixture.owner.headers, agent.id, { name: 'Other credential', expiresAt: null, grants: [{ scope: 'project', projectId: fixture.project.id, permissions: ['resource.read', 'resource.write', 'execution.run'] }] });
  const otherHeaders = new Headers({ authorization: `Bearer ${otherKey.rawKey}`, 'content-type': 'application/json' });
  const daemonA = randomUUID(), daemonB = randomUUID();
  for (const [id, nodeId] of [[daemonA, 'node-a'], [daemonB, 'node-b']]) await json(await api('/daemons/register', 'POST', { id, nodeId, name: 'Recovery fixture', role: 'executor', capabilities: ['codex', 'executor:codex', 'live-plan-v1'] }, agentHeaders), 201);
  const create = async (title: string, policy?: unknown) => json(await api(`/projects/${fixture.project.id}/requirements`, 'POST', { title, status: 'approved', recoveryPolicy: policy }), 201);
  const task = async (requirementId: string, title: string) => json(await api(`/projects/${fixture.project.id}/tasks`, 'POST', { requirementId, title }), 201);
  const acquire = (daemon = daemonA) => api(`/daemons/${daemon}/apply-requirement`, 'POST', { projectId: fixture.project.id, workerIndex: 0 }, agentHeaders);
  const requirement = await create('Plan reconciliation');
  const activeTask = await task(requirement.id, 'Work under current plan');
  const lane = await json(await acquire());
  assert.equal(lane.task.id, activeTask.id);
  const capability = await json(await api(`/daemons/${daemonA}/delegations`, 'POST', { requirementId: requirement.id, taskId: activeTask.id, workerIndex: 0, runId: lane.runId, leaseGeneration: lane.leaseGeneration }, agentHeaders), 201);
  const child = new Headers({ authorization: `Bearer ${capability.token}`, 'content-type': 'application/json' });
  // The supervisor must bind the spawn before reporting a direct child exit.
  const childIdentity = { requirementId: requirement.id, runId: lane.runId, leaseGeneration: lane.leaseGeneration, pid: 12345, processIdentity: 'fixture-start-identity' };
  const spawn = `/daemons/${daemonA}/managed-children/spawn`;
  const exit = `/daemons/${daemonA}/managed-children/exit`;
  const report = { ...childIdentity, status: 0, signal: null };
  assert.notEqual((await api(exit, 'POST', report, agentHeaders)).status, 201);
  assert.notEqual((await api(spawn, 'POST', childIdentity, child)).status, 201);
  assert.notEqual((await api(spawn, 'POST', childIdentity, fixture.owner.headers)).status, 201);
  assert.notEqual((await api(spawn, 'POST', { ...childIdentity, leaseGeneration: lane.leaseGeneration + 1 }, agentHeaders)).status, 201);
  assert.notEqual((await api(`/daemons/${daemonB}/managed-children/spawn`, 'POST', childIdentity, agentHeaders)).status, 201);
  assert.notEqual((await api('/daemons/register', 'POST', { id: daemonA, nodeId: 'node-a', name: 'Impersonator', role: 'executor', capabilities: ['codex'] }, otherHeaders)).status, 201);
  assert.notEqual((await api(spawn, 'POST', childIdentity, otherHeaders)).status, 201);
  await json(await api(spawn, 'POST', childIdentity, agentHeaders), 201);
  assert.notEqual((await api(exit, 'POST', report, otherHeaders)).status, 201);
  await fixture.identity.revokeKey(fixture.owner.headers, agent.id, key.id);
  assert.notEqual((await api(exit, 'POST', report, agentHeaders)).status, 201);
  assert.notEqual((await api(exit, 'POST', report, otherHeaders)).status, 201);
  await db.update(apiKeys).set({ revokedAt: null }).where(eq(apiKeys.id, key.id));
  assert.notEqual((await api(spawn, 'POST', childIdentity, agentHeaders)).status, 201);
  assert.notEqual((await api(exit, 'POST', { ...report, processIdentity: 'different-start' }, agentHeaders)).status, 201);
  assert.notEqual((await api(exit, 'POST', { ...report, pid: 12346 }, agentHeaders)).status, 201);
  const [firstExit, secondExit] = await Promise.all([
    api(exit, 'POST', report, agentHeaders), api(exit, 'POST', report, agentHeaders),
    db.update(requirements).set({ planRevision: 100 }).where(eq(requirements.id, requirement.id)),
  ]);
  assert.deepEqual([firstExit.status, secondExit.status].sort(), [201, 409]);
  assert.notEqual((await api(exit, 'POST', report, agentHeaders)).status, 201);
  // A changed lease generation fences both endpoints even when all process fields match.
  await db.update(requirements).set({ leaseGeneration: lane.leaseGeneration + 1 }).where(eq(requirements.id, requirement.id));
  assert.notEqual((await api(exit, 'POST', report, agentHeaders)).status, 201);
  assert.notEqual((await api(spawn, 'POST', childIdentity, agentHeaders)).status, 201);
});
