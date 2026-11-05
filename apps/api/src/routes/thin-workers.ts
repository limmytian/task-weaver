import { Hono } from 'hono';
import { createAuthorizedEventStream, createThinWorkerService, workerAcquireSchema, workerHeartbeatSchema, workerModeSchema, workerOutputSchema, workerReleaseSchema, workerResolveSchema, workerResultSchema } from '@task-weaver/core';
import { z } from 'zod';
import type { Env } from '../middleware/actor.js';

const routes = new Hono<Env>();
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
