import { authenticationFailure } from '@task-weaver/core';
import type { getWebAuthenticationRuntime } from '@/trpc/init';

export function createWorkerConsoleProxy(getRuntime: typeof getWebAuthenticationRuntime) {
  return async (request: Request, path: string[]) => {
    try {
      const { auth } = getRuntime();
      auth.assertOrigin(request.headers); await auth.verify(request.headers); auth.authentication.assertMutation(request.headers);
      const route = path.join('/');
      if (!/^(?:open|[a-z0-9_-]{1,32}\/[a-z0-9_.-]{1,160}\/(?:read|cancel))$/.test(route)) return Response.json({ error: 'Invalid console route' }, { status: 400 });
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = request.body?.getReader();
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); return Response.json({ error: 'Console request too large' }, { status: 413 }); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const name of ['authorization', 'cookie', 'origin', 'x-csrf-token']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
      const response = await fetch(`${process.env.TW_API_URL || 'http://localhost:3001'}/api/v1/worker-console/${route}`, { method: 'POST', headers, body: text, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return Response.json({ error: response.status === 404 ? 'Console expired, stopped or history unavailable' : response.status === 403 || response.status === 401 ? 'Console access ended' : 'Console unavailable or request timed out' }, { status: response.status, headers: { 'cache-control': 'no-store' } });
      return new Response(response.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch (error) {
      const failure = authenticationFailure(error);
      return Response.json({ error: failure.status < 500 ? failure.error : 'Console disconnected or unavailable' }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
    }
  };
}
