import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb, runMigrations, requirementClaims, requirements } from '@task-weaver/db';
import { WorkerConsoleService, createAuthenticationRuntime } from '@task-weaver/core';
import { eq } from 'drizzle-orm';
import { resourcePostgresFixture } from './resource-postgres-fixture';


const databaseUrl = process.env.TW_CONSOLE_E2E_DATABASE_URL;
test('console HTTP peers, live authorization, fencing and volatile lifecycle', { skip: !databaseUrl, timeout: 90_000 }, async t => {
  const url = new URL(databaseUrl!); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/tw_console_e2e');
  await runMigrations(databaseUrl!); const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const api = async (path: string, method = 'GET', body?: unknown, headers = f.owner.headers) => f.app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response, status = 200): Promise<any> => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Console fixture' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'maintainer', explicitPermissions: [] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: 'Console fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run', 'audit.read'] }] });
  const producer = new Headers({ authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' });
  const daemonId = randomUUID();
  await json(await api('/daemons/register', 'POST', { id: daemonId, nodeId: 'console-fixture', name: 'Console', role: 'executor', capabilities: ['codex', 'executor:codex', 'live-plan-v1'] }, producer), 201);
  const lanes = [];
  for (let workerIndex = 0; workerIndex < 2; workerIndex++) {
    const req = await json(await api(`/projects/${f.project.id}/requirements`, 'POST', { title: `Console lane ${workerIndex}`, status: 'approved' }), 201);
    const task = await json(await api(`/projects/${f.project.id}/tasks`, 'POST', { title: 'Console output fixture', requirementId: req.id }), 201);
    const lane = await json(await api(`/daemons/${daemonId}/apply-requirement`, 'POST', { projectId: f.project.id, workerIndex }, producer));
    lanes.push({ requirementId: req.id, taskId: task.id, runId: lane.runId, leaseGeneration: lane.leaseGeneration, workerIndex });
  }
  const target = lanes[0]!;
  const auth = createAuthenticationRuntime(db, f.configuration);
  const context = await auth.verify(producer);
  let clock = Date.now(); const service = new WorkerConsoleService('clock', () => clock); t.after(() => service.close());
  const follow = await service.open(db, f.owner.context, { ...target, follow: true });
  assert.equal((await service.demands(db, context, daemonId)).length, 1);
  await service.read(db, f.owner.context, follow.id, true);
  clock += 10_001; await assert.rejects(service.read(db, f.owner.context, follow.id, true));
  assert.equal((await service.demands(db, context, daemonId)).length, 0);
  const snapshot = await service.open(db, f.owner.context, target); clock += 15_001;
  await assert.rejects(service.read(db, f.owner.context, snapshot.id, false));
  const batch = { captureId: randomUUID(), revision: 0, frames: [{ sequence: 1, stream: 'stdout', text: `console-volatile-${randomUUID()}` }], firstSequence: 1, nextSequence: 2, truncated: false, unavailable: false };

  const slow = await service.open(db, f.owner.context, { ...target, follow: true });
  await service.respond(db, context, daemonId, slow.id, batch);
  clock += 600;
  await service.respond(db, context, daemonId, slow.id, { ...batch, revision: 1, firstSequence: 1, nextSequence: 3, frames: [{ ...batch.frames[0], sequence: 2 }] });
  const dropped = await service.read(db, f.owner.context, slow.id, true);
  assert(dropped.batch?.truncated); assert.equal(dropped.batch?.frames[0]?.sequence, 2);
  await assert.rejects(service.respond(db, context, daemonId, slow.id, { ...batch, revision: 2, firstSequence: 1, nextSequence: 4, frames: [{ ...batch.frames[0], sequence: 3 }] }), /rate exceeded/);
  clock += 15 * 60_000;
  await assert.rejects(service.read(db, f.owner.context, slow.id, true));


  const children: Array<ReturnType<typeof fork>> = [];
  const launch = async (node: string, port = 0) => {
    const child = fork(fileURLToPath(new URL('./console-api-child.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
      PATH: process.env.PATH, TW_CONSOLE_FIXTURE_DATABASE_URL: databaseUrl!, TW_CONSOLE_FIXTURE_PORT: String(port),
      TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0], TW_CONSOLE_NODE_ID: node,
    } });
    children.push(child);
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.equal(message.type, 'listening');
    const origin = `http://127.0.0.1:${message.port}`;
    return { child, origin, port: message.port as number, app: { request: (path: string, init: RequestInit) => fetch(`${origin}${path}`, init) }, async configure(peers: string) {
      const ready = once(child, 'message', { signal: AbortSignal.timeout(10_000) }); child.send({ type: 'configure', peers }); assert.equal((await ready)[0].type, 'ready');
    }, async stop() { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.send({ type: 'stop' }); await exited; } };
  };
  let appA = await launch('a'); const appB = await launch('b');
  const peers = JSON.stringify({ a: appA.origin, b: appB.origin });
  await Promise.all([appA.configure(peers), appB.configure(peers)]);
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const request = async (app: typeof appA, path: string, body?: unknown, headers = f.owner.headers) => app.app.request(`/api/v1/worker-console/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const path = (id: string, action: string) => `${id.split('.')[0]}/${id}/${action}`;
  assert([403, 404].includes((await request(appA, 'open', target, f.outsider.headers)).status));
  assert.equal((await request(appA, 'open', target, producer)).status, 403);
  assert.equal((await json(await request(appB, `demands/${daemonId}`, undefined, producer))).items.length, 0);
  const first = await json(await request(appA, 'open', target));
  assert.equal((await json(await request(appB, `demands/${daemonId}`, undefined, producer))).items[0].id, first.id);
  await json(await request(appB, path(first.id, 'response'), { daemonId, batch }, producer));
  assert.equal((await request(appB, path(first.id, 'response'), { daemonId, batch }, producer)).status, 409);
  const received = await json(await request(appB, path(first.id, 'read'), { follow: false }));
  assert.equal(received.batch.frames[0].text, batch.frames[0]!.text);
  assert.equal((await json(await request(appB, `demands/${daemonId}`, undefined, producer))).items.length, 0);
  assert.equal((await request(appA, path(first.id, 'read'), {}, f.outsider.headers)).status, 403);
  const viewers = await Promise.all([request(appA, 'open', { ...target, follow: true }).then(json), request(appA, 'open', { ...lanes[1], follow: true }).then(json)]);
  await json(await request(appB, path(viewers[0].id, 'cancel'), {}));
  const remaining = (await json(await request(appA, `demands/${daemonId}`, undefined, producer))).items;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].workerIndex, 1);
  await json(await request(appB, path(viewers[1].id, 'response'), { daemonId, batch }, producer));
  assert.equal((await request(appB, path(viewers[1].id, 'response'), { daemonId, batch: { ...batch, revision: 1, captureId: randomUUID(), frames: [], firstSequence: 2, nextSequence: 2 } }, producer)).status, 404);
  await f.identity.setMembership(f.owner.headers, f.project.id, f.outsider.context.actor.id, { role: 'maintainer', explicitPermissions: [] });
  const revoked = await json(await request(appA, 'open', { ...target, follow: true }, f.outsider.headers));
  await f.identity.removeMembership(f.owner.headers, f.project.id, f.outsider.context.actor.id);
  await request(appA, `demands/${daemonId}`, undefined, producer);
  await f.identity.setMembership(f.owner.headers, f.project.id, f.outsider.context.actor.id, { role: 'maintainer', explicitPermissions: [] });
  assert.equal((await request(appB, path(revoked.id, 'read'), {}, f.outsider.headers)).status, 404, 'regrant cannot revive a deleted session');
  const restart = await json(await request(appA, 'open', target));
  const restartedPort = appA.port; await appA.stop(); appA = await launch('a', restartedPort); await appA.configure(peers);
  assert.equal((await request(appB, path(restart.id, 'read'), {})).status, 404);
  const stale = await json(await request(appA, 'open', target));
  await json(await api(`/tasks/${target.taskId}`, 'PATCH', { description: 'Changed acceptance fences old console producer' }));
  assert.equal((await request(appA, path(stale.id, 'response'), { daemonId, batch }, producer)).status, 403);
  assert.equal((await json(await request(appB, `demands/${daemonId}`, undefined, producer))).items.length, 0);
  const oldTarget = lanes[1]!;
  const oldSession = await json(await request(appA, 'open', { ...oldTarget, follow: true }));
  const newRun = randomUUID();
  await db.update(requirementClaims).set({ id: newRun, generation: oldTarget.leaseGeneration + 1 }).where(eq(requirementClaims.id, oldTarget.runId));
  await db.update(requirements).set({ leaseGeneration: oldTarget.leaseGeneration + 1 }).where(eq(requirements.id, oldTarget.requirementId));
  assert.equal((await request(appB, path(oldSession.id, 'response'), { daemonId, batch }, producer)).status, 403);
  assert.equal((await json(await request(appB, `demands/${daemonId}`, undefined, producer))).items.length, 0);
  assert.equal((await request(appA, path(oldSession.id, 'read'), {})).status, 404, 'returned old run cannot revive its observation');
  const replacement = await json(await request(appA, 'open', { ...oldTarget, runId: newRun, leaseGeneration: oldTarget.leaseGeneration + 1 }));
  await json(await request(appB, path(replacement.id, 'response'), { daemonId, batch }, producer));
  await json(await request(appB, path(replacement.id, 'read'), {}));
  // The unique output sentinel must not occur anywhere in the durable application data.
  const tables = await db.$client<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'task_weaver'`;
  assert(tables.length > 20);
  for (const { tablename } of tables) {
    const rows = await db.$client.unsafe(`SELECT row_to_json(t)::text AS body FROM "task_weaver"."${tablename.replaceAll('"', '""')}" t`);
    assert(!rows.some(row => String(row.body).includes(batch.frames[0]!.text)), `Console body persisted in ${tablename}`);
  }
  assert.equal((await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, target.requirementId) }))!.id, target.runId);
  await appA.stop();
  assert.equal((await request(appB, path(first.id, 'read'), {})).status, 503, 'unreachable owner must fail visibly without durable fallback');
  await f.identity.revokeKey(f.owner.headers, agent.id, key.id);
  assert.equal((await api('/auth/me', 'GET', undefined, producer)).status, 401);
  await appB.stop();
});
