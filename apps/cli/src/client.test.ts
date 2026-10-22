import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request, ApiTransportError } from './client.js'
import { transportError } from './transport-error.js'

test('transport diagnostics classify nested failures without copying secrets or endpoint data', () => {
  const secret = 'private-host-token-and-url'
  for (const [code, expected] of [['ENOTFOUND', 'network_dns'], ['CERT_HAS_EXPIRED', 'network_tls'], ['UND_ERR_CONNECT_TIMEOUT', 'network_timeout'], ['ECONNRESET', 'network_connection']] as const) {
    const result = transportError(new TypeError(secret, { cause: new AggregateError([Object.assign(new Error(secret), { code })]) }), 'POST')
    assert.equal(result.code, expected)
    assert.equal(result.mutationMayHaveCommitted, true)
    assert.ok(result.message.includes('inspect current state'))
    assert.equal(result.message.includes(secret), false)
    assert.equal(Object.hasOwn(result, 'cause'), false)
  }
  assert.equal(transportError(new Error(secret), 'GET').mutationMayHaveCommitted, false)
  assert.equal(transportError(new Error(secret), 'GET').code, 'network_failed')
})

test('real socket loss after a mutation never replays it and later explicit reads recover', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tw-client-transport-'))
  const previous = process.env.TW_CONFIG_DIR
  process.env.TW_CONFIG_DIR = directory
  t.after(async () => { if (previous === undefined) delete process.env.TW_CONFIG_DIR; else process.env.TW_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }) })
  let committed = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST') { committed++; req.socket.destroy(); return }
    if (req.url === '/invalid') { res.end('private-host-response'); return }
    if (req.url === '/slow') return
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ committed }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const credential = { apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-private-key' }
  await assert.rejects(request('POST', '/commit', {}, { credential }), error => error instanceof ApiTransportError && error.code === 'network_connection' && error.mutationMayHaveCommitted)
  assert.deepEqual(await request('GET', '/state', undefined, { credential }), { committed: 1 })
  await assert.rejects(request('GET', '/invalid', undefined, { credential }), error => error instanceof ApiTransportError && error.code === 'invalid_response' && !error.message.includes('private-host-response'))
  await assert.rejects(request('GET', '/slow', undefined, { credential, signal: AbortSignal.timeout(100) }), error => error instanceof ApiTransportError && error.code === 'network_timeout')
  const cancelled = new AbortController(); cancelled.abort(new Error('private-abort-reason'))
  await assert.rejects(request('GET', '/state', undefined, { credential, signal: cancelled.signal }), error => error instanceof ApiTransportError && error.code === 'network_cancelled' && !error.message.includes('private-abort-reason'))
  assert.equal(committed, 1)
})
