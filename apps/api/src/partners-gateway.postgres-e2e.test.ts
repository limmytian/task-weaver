import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, tiAgentModelConfigs, tiAgentPolicies, tiAgentRuns, workerAttempts } from '@task-weaver/db';
import { apiKeyService, createResourceServices, createRequirementSchema, createThinWorkerService } from '@task-weaver/core';
import { createPartnersGatewayClient } from '@task-weaver/partners-gateway';
import { TiAgentGatewayWorker, createGatewayTwAuthority } from '@task-weaver/partners-gateway/worker';
import { resourcePostgresFixture } from './resource-postgres-fixture';

const databaseUrl = process.env.TW_GATEWAY_E2E_DATABASE_URL;

test('Partners Gateway uses scoped worker attempts over HTTP and SSE', { skip: !databaseUrl, timeout: 90_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/tw_gateway_e2e');
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const owner = { id: f.owner.context.actor.id, type: 'human' as const };
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Gateway test worker' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'member', explicitPermissions: ['execution.run'] });
  const key = await apiKeyService.issueScopedApiKey(db, f.owner.context, agent.id, { name: 'Gateway test key', grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run'] }], expiresAt: null });
  const actor = { id: agent.id, type: 'agent' as const };
  const services = createResourceServices(f.owner.context);
  const req = await services.requirementService.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: 'Gateway E2E', status: 'approved' }), owner);
  await db.insert(tiAgentModelConfigs).values({ ownerId: owner.id, ownerType: 'human', provider: 'fixture', model: 'fixture', enabled: true, isDefaultAgent: true, credentialStatus: 'valid' });
  await db.insert(tiAgentPolicies).values({ ownerId: owner.id, ownerType: 'human', enabled: true, executionMode: 'dry_run' });
  let state = 'succeeded';
  let requests = 0;
  const gateway = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture-token') return void response.writeHead(401).end();
    if (request.method === 'POST') {
      requests++;
      if (state === 'unavailable') return void response.writeHead(503).end('unavailable');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      return void response.end(JSON.stringify({ id: body.id, state: 'running', executionMode: 'ephemeral_interpreter' }));
    }
    if (request.url?.endsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'log.stdout', sequence: 1, state: 'running', chunk: 'fixture progress' })}\n\n`);
      await delay(30);
      if (state === 'polling') return void response.end();
      return void response.end(`data: ${JSON.stringify({ type: 'job.state', sequence: 2, state })}\n\n`);
    }
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/artifacts')) return void response.end(JSON.stringify({ items: [{ id: 'result', path: '/workspace/result.json' }] }));
    response.end(JSON.stringify({ id: request.url?.split('/').at(-1), state: 'succeeded', executionMode: 'ephemeral_interpreter' }));
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.closeAllConnections(); return new Promise<void>(resolve => gateway.close(() => resolve())); });
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const config = { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, serviceToken: 'fixture-token', defaultTimeoutSeconds: 900 };
  const authority = createGatewayTwAuthority(db, config, { actorId: agent.id, assignedAgentId: agent.id } as never, () => key.rawKey);
  const worker = new TiAgentGatewayWorker(db, createPartnersGatewayClient(config), config, {
    actor, assignedAgentId: agent.id, workerId: 'gateway-test', leaseDurationMinutes: 1, heartbeatIntervalMs: 20,
    progressFlushIntervalMs: 1, idlePollIntervalMs: 20, statusPollIntervalMs: 20, retryBaseDelayMs: 30, retryMaxDelayMs: 30,
  }, { ...authority, wait: async () => true, now: Date.now, log: { info() {}, error() {} } });
  async function enqueue() {
    const task = await services.taskService.createTask(db, { projectId: f.project.id, requirementId: req.id, title: `Gateway ${randomUUID()}`, assignee: agent.id, assigneeType: 'agent' }, owner);
    const run = await services.tiAgentService.createRun(db, { taskId: task.id, assignedAgentId: agent.id, assignedAgentType: 'agent', maxRetries: 1 }, owner);
    return { task, run };
  }
  for (const scenario of ['succeeded', 'failed', 'cancelled', 'timed_out', 'polling']) {
    await t.test(`persists ${scenario} with a fenced attempt`, async () => {
      state = scenario;
      const { task, run } = await enqueue();
      assert.equal(await worker.runOnce(new AbortController().signal), true);
      const stored = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) });
      assert.equal(stored!.status, scenario === 'polling' ? 'succeeded' : scenario === 'timed_out' ? 'failed' : scenario);
      const attempt = await db.query.workerAttempts.findFirst({ where: eq(workerAttempts.taskId, task.id) });
      assert.equal(attempt!.status, ['succeeded', 'polling'].includes(scenario) ? 'completed' : 'attention');
      assert.ok(stored!.eventLog?.length);
      if (attempt!.status === 'attention') await createThinWorkerService(f.owner.context).resolve(db, { attemptId: attempt!.id, disposition: 'review', reason: 'Fixture gateway stopped and inspected' });
    });
  }
  await t.test('uncertain dispatch fails without automatically submitting a second job', async () => {
    state = 'unavailable';
    const { task, run } = await enqueue();
    const before = requests;
    await assert.rejects(() => worker.runOnce(new AbortController().signal));
    assert.equal(requests, before + 1);
    assert.equal((await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, run.id) }))?.status, 'failed');
    assert.equal((await db.query.workerAttempts.findFirst({ where: eq(workerAttempts.taskId, task.id) }))?.status, 'attention');
    assert.equal(await worker.runOnce(new AbortController().signal), false);
  });
});
