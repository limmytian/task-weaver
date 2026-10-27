import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EvidenceSessionService, evidenceLimits } from '@task-weaver/core';
import type { Env } from '../middleware/actor.js';
import type { Database } from '@task-weaver/db';

/** Explicitly enabled while the producer protocol is being rolled out. */
export function createEvidenceRoutes(enabled: boolean) {
  const router = new Hono<Env>();
  let service: EvidenceSessionService | undefined;
  const getService = (db: Database) => {
    if (!enabled) return undefined;
    return service ??= new EvidenceSessionService(db);
  };
  const id = z.string().uuid();
  const request = z.object({ requirementId: id, outputId: id, purpose: z.enum(['download', 'promotion']) }).strict();
  const producer = z.object({ daemonId: id }).strict();
  const claim = producer.extend({ signature: z.string().max(128) }).strict();
  const chunk = producer.extend({ sequence: z.number().int().nonnegative(), contentBase64: z.string().max(Math.ceil(evidenceLimits.chunkBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
  const finish = producer.extend({ sequence: z.number().int().nonnegative() }).strict();
  const failure = producer.extend({ state: z.enum(['missing', 'changed', 'unsupported', 'too_large']) }).strict();
  router.use('*', bodyLimit({ maxSize: 96 * 1024, onError: c => c.json({ error: 'Evidence request too large' }, 413) }));
  router.use('*', async (c, next) => { if (!enabled) return c.json({ error: 'Evidence transport is unavailable' }, 503); await next(); });
  router.post('/open', async c => {
    const parsed = request.safeParse(await c.req.json()); if (!parsed.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.open(c.get('identity'), parsed.data.requirementId, parsed.data.outputId, parsed.data.purpose), 201);
  });
  router.get('/demands/:daemonId', async c => {
    const daemon = id.safeParse(c.req.param('daemonId')); if (!daemon.success) return c.json({ error: 'Invalid daemon' }, 400);
    return c.json({ items: await getService(c.get('db'))!.poll(c.get('identity'), daemon.data) });
  });
  router.post('/:id/claim', async c => {
    const requestId = id.safeParse(c.req.param('id')); const parsed = claim.safeParse(await c.req.json());
    if (!requestId.success || !parsed.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.claim(c.get('identity'), parsed.data.daemonId, requestId.data, parsed.data.signature));
  });
  router.post('/:id/chunk', async c => {
    const requestId = id.safeParse(c.req.param('id')); const parsed = chunk.safeParse(await c.req.json());
    if (!requestId.success || !parsed.success) return c.json({ error: 'Invalid evidence frame' }, 400);
    const bytes = Buffer.from(parsed.data.contentBase64, 'base64');
    if (bytes.toString('base64') !== parsed.data.contentBase64 || bytes.length > evidenceLimits.chunkBytes) return c.json({ error: 'Invalid evidence frame' }, 400);
    return c.json(await getService(c.get('db'))!.push(c.get('identity'), parsed.data.daemonId, requestId.data, parsed.data.sequence, bytes));
  });
  router.post('/:id/finish', async c => {
    const requestId = id.safeParse(c.req.param('id')); const parsed = finish.safeParse(await c.req.json());
    if (!requestId.success || !parsed.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.finish(c.get('identity'), parsed.data.daemonId, requestId.data, parsed.data.sequence));
  });
  router.post('/:id/fail', async c => {
    const requestId = id.safeParse(c.req.param('id')); const parsed = failure.safeParse(await c.req.json());
    if (!requestId.success || !parsed.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.fail(c.get('identity'), parsed.data.daemonId, requestId.data, parsed.data.state));
  });
  router.post('/:id/promote', async c => {
    const requestId = id.safeParse(c.req.param('id')); if (!requestId.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.promote(c.get('identity'), requestId.data));
  });
  router.post('/:id/cancel', async c => {
    const requestId = id.safeParse(c.req.param('id')); if (!requestId.success) return c.json({ error: 'Invalid evidence request' }, 400);
    await getService(c.get('db'))!.cancel(c.get('identity'), requestId.data); return c.json({ cancelled: true });
  });
  router.get('/:id/status', async c => {
    const requestId = id.safeParse(c.req.param('id')); if (!requestId.success) return c.json({ error: 'Invalid evidence request' }, 400);
    return c.json(await getService(c.get('db'))!.status(c.get('identity'), requestId.data));
  });
  router.get('/:id/content', async c => {
    const requestId = id.safeParse(c.req.param('id')); if (!requestId.success) return c.json({ error: 'Invalid evidence request' }, 400);
    const manager = getService(c.get('db'))!; const context = c.get('identity');
    const status = await manager.status(context, requestId.data);
    if (status.state !== 'verified') return c.json({ error: 'Evidence is not ready' }, 409);
    const iterator = manager.read(context, requestId.data, c.req.raw.signal);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) { try { const value = await iterator.next(); if (value.done) controller.close(); else controller.enqueue(value.value); } catch (error) { controller.error(error); } },
      async cancel() { await iterator.return(undefined); },
    });
    return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(status.sizeBytes), 'content-disposition': 'attachment; filename="evidence.bin"', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' } });
  });
  return { router, close: () => service?.close() };
}
