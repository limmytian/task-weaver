import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { createTaskWorkerAccess } from './task-worker-access.js'
import { runCommand } from './async-command.js'

const supervisorKey = `tw_${'c'.repeat(64)}`
const token = `twd_${'d'.repeat(64)}`

test('worker TW commands use a broker while supervisor, provider and Git secrets stay outside the child environment', async () => {
  const actorId = randomUUID(), daemonId = randomUUID(), requirementId = randomUUID(), taskId = randomUUID(), runId = randomUUID()
  let revoked = 0
  let authorized = true
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === `/api/v1/daemons/${daemonId}/delegations`) {
      assert.equal(req.headers.authorization, `Bearer ${supervisorKey}`)
      res.statusCode = 201
      res.end(JSON.stringify({ token, delegation: {
        id: randomUUID(), parentCredentialId: randomUUID(), delegatorActorId: actorId, initiator: { id: actorId, type: 'agent' }, executorActorId: actorId,
        projectId: randomUUID(), requirementId, taskIds: [taskId], repositoryIds: [], runId, purpose: 'execute', leaseGeneration: 1,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } }))
    } else if (req.method === 'DELETE') {
      assert.equal(req.headers.authorization, `Bearer ${supervisorKey}`)
      revoked++
      res.end('{}')
    } else {
      assert.equal(req.headers.authorization, `Bearer ${token}`)
      res.statusCode = authorized ? 200 : 401
      res.end(JSON.stringify(authorized ? { actor: { id: actorId, type: 'agent' } } : { error: 'credential_revoked' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const previous = { provider: process.env.OPENAI_API_KEY, git: process.env.GITHUB_TOKEN, key: process.env.TW_API_KEY }
  process.env.OPENAI_API_KEY = 'provider-secret-canary'
  process.env.GITHUB_TOKEN = 'git-secret-canary'
  process.env.TW_API_KEY = supervisorKey
  let access: Awaited<ReturnType<typeof createTaskWorkerAccess>> | undefined
  try {
    access = await createTaskWorkerAccess({ config: { apiUrl: `http://127.0.0.1:${address.port}`, apiKey: supervisorKey }, daemonId, requirementId, taskId, runId, workerIndex: 0, leaseGeneration: 1 })
    assert.notEqual(access.environment.HOME, process.env.HOME)
    assert.match(access.environment.TW_API_KEY!, /^twb_[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(access.environment).includes(supervisorKey))
    assert.equal(access.environment.OPENAI_API_KEY, undefined)
    assert.equal(access.environment.GITHUB_TOKEN, undefined)
    const child = await runCommand(process.execPath, ['-e', `fetch(process.env.TW_API_URL + '/api/v1/auth/me', {headers: {authorization: 'Bearer ' + process.env.TW_API_KEY}}).then(async r => {if (!r.ok) process.exit(1); console.log((await r.json()).actor.id)})`], { env: access.environment, signal: access.signal, timeoutMs: 5000 })
    assert.equal(child.status, 0)
    assert.equal(child.stdout.trim(), actorId)
    assert.equal(access.redact(`${supervisorKey} ${token} ${access.environment.TW_API_KEY}`), '[redacted] [redacted] [redacted]')
    authorized = false
    await new Promise<void>(resolve => access!.signal.addEventListener('abort', () => resolve(), { once: true }))
    assert.equal(access.signal.aborted, true)
    const home = access.environment.HOME!
    await access.close()
    access = undefined
    assert.equal(existsSync(home), false)
    assert.equal(revoked, 1)
  } finally {
    await access?.close()
    for (const [key, value] of [['OPENAI_API_KEY', previous.provider], ['GITHUB_TOKEN', previous.git], ['TW_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
