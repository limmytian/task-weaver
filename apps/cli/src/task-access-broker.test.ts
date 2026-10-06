import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { request } from './client.js'
import { createTaskAccessBroker, type TaskCapability } from './task-access-broker.js'

function capability(expiry = Date.now() + 600_000): TaskCapability {
  const actor = randomUUID()
  return { token: `twd_${'a'.repeat(64)}`, delegation: {
    id: randomUUID(), parentCredentialId: randomUUID(), delegatorActorId: actor,
    initiator: { id: actor, type: 'agent' }, executorActorId: actor,
    projectId: randomUUID(), requirementId: randomUUID(), taskIds: [randomUUID()], repositoryIds: [],
    runId: randomUUID(), purpose: 'execute', leaseGeneration: 1, expiresAt: new Date(expiry).toISOString(),
  } }
}

test('task broker exposes an opaque loopback handle and strips ambient credentials', async () => {
  const cap = capability()
  const revoked: string[] = []
  const calls: string[] = []
  const broker = await createTaskAccessBroker({ apiUrl: 'https://tw.example', capability: cap,
    renew: async () => { throw new Error('Unexpected renewal') }, revoke: async id => { revoked.push(id) },
    fetch: async (url, input) => {
      calls.push(String(url))
      const headers = new Headers(input?.headers)
      assert.equal(headers.get('authorization'), `Bearer ${cap.token}`)
      assert.equal(headers.get('cookie'), null)
      assert.equal(headers.get('x-actor-id'), null)
      assert.equal(input?.redirect, 'error')
      return Response.json({ id: cap.delegation.taskIds[0] })
    },
  })
  try {
    assert.match(broker.apiUrl, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
    assert.match(broker.apiKey, /^twb_[0-9a-f]{64}$/)
    assert.notEqual(broker.apiKey, cap.token)
    const headers = { authorization: `Bearer ${broker.apiKey}`, cookie: 'supervisor-session', 'x-actor-id': 'forged-human' }
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/tasks/${cap.delegation.taskIds[0]}`, { headers })).status, 200)
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/projects/${cap.delegation.projectId}/tasks`, { headers })).status, 200)
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/auth/api-keys`, { headers })).status, 403)
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/daemons/register`, { headers, method: 'POST' })).status, 403)
    assert.equal((await fetch(`${broker.apiUrl}/api/v1/tasks/${cap.delegation.taskIds[0]}`)).status, 401)
    const result = await request<{ id: string }>('GET', `/api/v1/tasks/${cap.delegation.taskIds[0]}`, undefined, { credential: broker })
    assert.equal(result.id, cap.delegation.taskIds[0])
    assert.equal(calls.length, 3)
  } finally { await broker.close() }
  assert.deepEqual(revoked, [cap.delegation.id])
})

test('task broker rejects expired and excessive lifetimes before binding', async () => {
  for (const cap of [capability(Date.now() - 1), capability(Date.now() + 16 * 60_000)]) {
    await assert.rejects(createTaskAccessBroker({ apiUrl: 'https://tw.example', capability: cap,
      renew: async () => cap, revoke: async () => {},
    }), /Invalid task capability/)
  }
})

test('upstream revocation closes task access and invokes cancellation without retrying broader credentials', async () => {
  const cap = capability()
  let invalidations = 0
  let calls = 0
  const broker = await createTaskAccessBroker({ apiUrl: 'https://tw.example', capability: cap,
    renew: async () => cap, revoke: async () => {}, onInvalidation: () => { invalidations++ },
    fetch: async () => { calls++; return Response.json({ error: 'credential_revoked' }, { status: 401 }) },
  })
  try {
    await fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${broker.apiKey}` } }).catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(invalidations, 1)
    assert.equal(calls, 1)
    await assert.rejects(fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${broker.apiKey}` } }))
  } finally { await broker.close() }
})

test('renewal rotates private tokens and rejects expansion of the task bound', async () => {
  for (const expand of [false, true]) {
    const cap = capability(Date.now() + 1500)
    let invalidations = 0
    let observed = ''
    let notifyRenewed!: () => void
    const didRenew = new Promise<void>(resolve => { notifyRenewed = resolve })
    const next = { token: `twd_${'b'.repeat(64)}`, delegation: { ...cap.delegation, id: randomUUID(),
      taskIds: expand ? [...cap.delegation.taskIds, randomUUID()] : cap.delegation.taskIds,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    } }
    const broker = await createTaskAccessBroker({ apiUrl: 'https://tw.example', capability: cap,
      renew: async () => { notifyRenewed(); return next }, revoke: async () => {},
      onInvalidation: () => { invalidations++ },
      fetch: async (_url, input) => { observed = new Headers(input?.headers).get('authorization')!; return Response.json({ ok: true }) },
    })
    try {
      await didRenew
      await new Promise(resolve => setImmediate(resolve))
      if (expand) {
        assert.equal(invalidations, 1)
        await assert.rejects(fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${broker.apiKey}` } }))
      } else {
        assert.equal((await fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${broker.apiKey}` } })).status, 200)
        assert.equal(observed, `Bearer ${next.token}`)
      }
    } finally { await broker.close() }
  }
})

test('expiry cancels in-flight access even when the supervisor renewal cannot complete', async () => {
  const cap = capability(Date.now() + 100)
  let invalidations = 0
  const broker = await createTaskAccessBroker({ apiUrl: 'https://tw.example', capability: cap,
    renew: async () => { throw new Error('Unavailable supervisor') }, revoke: async () => {},
    onInvalidation: () => { invalidations++ },
    fetch: async (_url, input) => new Promise((_resolve, reject) => {
      input!.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
    }),
  })
  try {
    await assert.rejects(fetch(`${broker.apiUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${broker.apiKey}` } }))
    assert.equal(invalidations, 1)
  } finally { await broker.close() }
})
