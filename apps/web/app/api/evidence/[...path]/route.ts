import { authenticationFailure } from '@task-weaver/core';
import { getWebAuthenticationRuntime } from '@/trpc/init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function transfer(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { auth } = getWebAuthenticationRuntime();
    auth.assertOrigin(request.headers); await auth.verify(request.headers);
    if (request.method === 'POST') auth.authentication.assertMutation(request.headers);
    const route = (await context.params).path.join('/');
    if (!(request.method === 'POST' && /^(?:open|[0-9a-f-]{36}\/(?:cancel|promote))$/.test(route) || request.method === 'GET' && /^[0-9a-f-]{36}\/(?:status|content)$/.test(route))) return Response.json({ error: 'Invalid evidence route' }, { status: 400 });
    let body: string | undefined;
    if (request.method === 'POST') {
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); return Response.json({ error: 'Request too large' }, { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); }
      body = Buffer.concat(chunks).toString('utf8');
    }
    const headers = new Headers();
    for (const name of ['authorization', 'cookie', 'origin', 'x-csrf-token', 'content-type']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    const response = await fetch(`${process.env.TW_API_URL || 'http://localhost:3001'}/api/v1/evidence/${route}`, { method: request.method, headers, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]) });
    if (!response.ok) return Response.json({ error: response.status === 404 ? 'Evidence is unavailable' : response.status === 401 || response.status === 403 ? 'Evidence access ended' : 'Evidence request failed' }, { status: response.status, headers: { 'cache-control': 'no-store' } });
    const resultHeaders = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    for (const name of ['content-type', 'content-length', 'content-disposition']) { const value = response.headers.get(name); if (value) resultHeaders.set(name, value); }
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  } catch (error) { const failure = authenticationFailure(error); return Response.json({ error: failure.status < 500 ? failure.error : 'Evidence is unavailable' }, { status: failure.status, headers: { 'cache-control': 'no-store' } }); }
}
export const GET = transfer;
export const POST = transfer;
