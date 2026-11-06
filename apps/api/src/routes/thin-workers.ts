import { Hono } from 'hono';
import { ConflictError, ValidationError, authenticationFailure, createAuthorizedEventStream, createThinWorkerService, workerAcquireSchema, workerFenceSchema, workerHeartbeatSchema, workerModeSchema, workerOutputSchema, workerPlanSchema, workerPresenceSchema, workerReleaseSchema, workerResolveSchema, workerResultSchema } from '@task-weaver/core';
import { z } from 'zod';
import type { Env } from '../middleware/actor.js';

const routes = new Hono<Env>();
routes.onError((error, c) => {
  if (error instanceof ConflictError) return c.json({ error: error.message, code: 'conflict', currentVersion: error.currentVersion }, 409);
  if (error instanceof ValidationError) return c.json({ error: error.message, code: 'validation_failed' }, 400);
  const failure = authenticationFailure(error);
  return c.json({ error: failure.error, code: failure.code }, failure.status);
});
routes.get('/events', async c => {
  const project = z.string().uuid().safeParse(c.req.query('projectId'));
  if (!project.success) return c.json({ error: 'Invalid project' }, 400);
  return createAuthorizedEventStream(c.get('db'), c.get('identity'), c.req.raw, { projectId: project.data });
});
routes.get('/attempts', async c => {
  const project = z.string().uuid().safeParse(c.req.query('projectId'));
  if (!project.success) return c.json({ error: 'Invalid project' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).list(c.get('db'), project.data));
});
routes.get('/presence', async c => {
  const project = z.string().uuid().safeParse(c.req.query('projectId'));
  if (!project.success) return c.json({ error: 'Invalid project' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).listWorkers(c.get('db'), project.data));
});
routes.post('/presence', async c => {
  const input = workerPresenceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker presence' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).presence(c.get('db'), input.data));
});
routes.post('/presence/stop', async c => {
  const input = workerPresenceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker presence' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).stopPresence(c.get('db'), input.data));
});
routes.post('/mode', async c => {
  const input = workerModeSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker mode request' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).setMode(c.get('db'), input.data));
});
routes.post('/acquire', async c => {
  const input = workerAcquireSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker acquisition' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).acquire(c.get('db'), input.data));
});
routes.post('/heartbeat', async c => {
  const input = workerHeartbeatSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker heartbeat' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).heartbeat(c.get('db'), input.data));
});
routes.post('/output', async c => {
  const input = workerOutputSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker output' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).registerOutput(c.get('db'), input.data));
});
routes.post('/inputs', async c => {
  const input = workerFenceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid acceptance input request' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).inputs(c.get('db'), input.data));
});
routes.post('/plan', async c => {
  const input = workerPlanSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid coordinator plan' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).applyPlan(c.get('db'), input.data));
});
routes.post('/result', async c => {
  const input = workerResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker result' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).result(c.get('db'), input.data));
});
routes.post('/release', async c => {
  const input = workerReleaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker release' }, 400);
  const { reason, ...fence } = input.data;
  return c.json(await createThinWorkerService(c.get('identity')).result(c.get('db'), { ...fence, outcome: 'attention', summary: reason }));
});
routes.post('/resolve', async c => {
  const input = workerResolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid worker resolution' }, 400);
  return c.json(await createThinWorkerService(c.get('identity')).resolve(c.get('db'), input.data));
});
export default routes;
