import { Hono } from 'hono';
import { WorkerConsoleService, ValidationError, consoleLimits, consoleDemandSchema } from '@task-weaver/core';
import type { Env } from '../middleware/actor.js';

/** Peer destinations are operator configuration, never client-provided URLs. */
export function createWorkerConsoleRoutes(env: NodeJS.ProcessEnv) {
  const node = env.TW_CONSOLE_NODE_ID ?? 'local';
  if (!/^[a-z0-9_-]{1,32}$/.test(node)) throw new Error('Invalid console node identifier');
  const peers = new Map<string, string>();
  const configured: unknown = JSON.parse(env.TW_CONSOLE_PEERS ?? '{}');
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('Invalid console peers');
  for (const [name, value] of Object.entries(configured)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || typeof value !== 'string') throw new Error('Invalid console peer');
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Console peers require trusted HTTPS origins');
    peers.set(name, url.origin);
  }
  if (peers.size > consoleLimits.peers) throw new Error('Too many console peers');
  const service = new WorkerConsoleService(node);
  const router = new Hono<Env>();
  async function boundedBody(request: Pick<Request, 'body'>) {
    const reader = request.body?.getReader(); if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new ValidationError('Console request too large'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  async function forward(request: Request, target: string, path: string, body?: string) {
    const origin = peers.get(target);
    if (!origin || target === node) return new Response(JSON.stringify({ error: 'Console routing unavailable; history is not retained' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const headers = new Headers();
    for (const name of ['authorization', 'cookie', 'origin', 'x-csrf-token', 'content-type']) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    try {
      const response = await fetch(`${origin}/api/v1/worker-console${path}`, { method: request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(1500) });
      // Do not relay arbitrary peer response headers or log its body on errors.
      const text = await boundedBody(response);
      return new Response(response.ok ? text : JSON.stringify({ error: 'Console peer rejected or expired the request' }), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch { return new Response(JSON.stringify({ error: 'Console peer unavailable; output gap' }), { status: 503, headers: { 'content-type': 'application/json' } }); }
  }
  const parse = (text: string | undefined): Record<string, unknown> => {
    try { const value = JSON.parse(text ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Do not include the malformed body in errors. */ }
    throw new ValidationError('Invalid console JSON');
  };
  router.post('/open', async c => c.json(await service.open(c.get('db'), c.get('identity'), parse(await boundedBody(c.req.raw)))));
  router.get('/demands/:daemonId', async c => {
    const daemonId = c.req.param('daemonId');
    const local = await service.demands(c.get('db'), c.get('identity'), daemonId);
    const results = await Promise.all([...peers.keys()].filter(key => key !== node).map(async key => {
      const response = await forward(c.req.raw, key, `/${key}/demands/${encodeURIComponent(daemonId)}`);
      if (!response.ok) return [];
      try {
        const body = await response.json() as { items: unknown[] };
        return body.items.slice(0, consoleLimits.sessions).flatMap(item => { const parsed = consoleDemandSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
      } catch { return []; }
    }));
    return c.json({ items: [...local, ...results.flat()] });
  });
  router.get('/:node/demands/:daemonId', async c => {
    if (c.req.param('node') !== node) return c.json({ error: 'Console routing unavailable' }, 503);
    return c.json({ items: await service.demands(c.get('db'), c.get('identity'), c.req.param('daemonId')) });
  });
  router.post('/:node/:id/:action', async c => {
    const target = c.req.param('node'); const id = c.req.param('id'); const action = c.req.param('action');
    if (!/^[a-z0-9_-]{1,32}\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/.test(id) || id.split('.')[0] !== target || !['read', 'cancel', 'response'].includes(action)) return c.json({ error: 'Invalid console request' }, 400);
    const body = await boundedBody(c.req.raw);
    if (target !== node) return forward(c.req.raw, target, `/${target}/${id}/${action}`, body);
    const input = parse(body);
    if (action === 'read') return c.json(await service.read(c.get('db'), c.get('identity'), id, input.follow === true));
    if (action === 'cancel') return c.json(await service.cancel(c.get('db'), c.get('identity'), id));
    return c.json(await service.respond(c.get('db'), c.get('identity'), typeof input.daemonId === 'string' ? input.daemonId : '', id, input.batch));
  });
  return { router, close: () => service.close() };
}
