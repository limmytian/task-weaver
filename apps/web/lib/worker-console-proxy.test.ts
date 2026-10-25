import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerConsoleProxy } from './worker-console-proxy';
import type { getWebAuthenticationRuntime } from '@/trpc/init';

test('console proxy verifies identity and CSRF and only forwards viewer routes', async () => {
  const original = globalThis.fetch; let calls = 0; let verified = 0; let mutation = 0;
  const runtime = (() => ({ auth: { assertOrigin() {}, async verify() { verified++; }, authentication: { assertMutation() { mutation++; } } } })) as unknown as typeof getWebAuthenticationRuntime;
  const proxy = createWorkerConsoleProxy(runtime);
  globalThis.fetch = async (url, options) => {
    calls++; assert(String(url).endsWith('/api/v1/worker-console/open'));
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('cookie'), 'session=fixture'); assert.equal(headers.get('x-csrf-token'), 'fixture-csrf');
    assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    return Response.json({ id: 'fixture' });
  };
  const request = (body = '{}') => new Request('http://localhost/api/worker-console/open', { method: 'POST', headers: { cookie: 'session=fixture', 'x-csrf-token': 'fixture-csrf' }, body });
  try {
    assert.equal((await proxy(request(), ['open'])).status, 200);
    assert.equal((await proxy(request(), ['local', 'id', 'response'])).status, 400);
    assert.equal((await proxy(request('x'.repeat(4097)), ['open'])).status, 413);
    assert.equal(calls, 1); assert.equal(verified, 3); assert.equal(mutation, 3);
  } finally { globalThis.fetch = original; }
});
