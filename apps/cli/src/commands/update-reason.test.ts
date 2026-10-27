import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { registerTasks } from './tasks.js'
import { registerRequirements } from './requirements.js'

async function run(args: string[]) {
  const originalFetch = globalThis.fetch, originalLog = console.log
  const names = ['TW_API_URL', 'TW_API_KEY', 'TW_CLIENT_ID', 'TW_NODE_ID'] as const
  const previous = names.map(name => process.env[name])
  process.env.TW_API_URL = 'http://fixture.test'
  process.env.TW_API_KEY = 'fixture-only-key'
  process.env.TW_CLIENT_ID = 'fixture-client'
  process.env.TW_NODE_ID = 'fixture-node'
  const calls: Array<{ path: string; method?: string; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ id: 'fixture-id' }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  console.log = () => {}
  try {
    const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
    registerTasks(program); registerRequirements(program)
    await program.parseAsync(args, { from: 'user' })
    return calls
  } finally {
    globalThis.fetch = originalFetch; console.log = originalLog
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
  }
}

test('task and requirement update accept and forward audit reasons without dropping other fields', async () => {
  assert.deepEqual(await run(['task', 'update', 'fixture-id', '--title', 'Revised task', '--reason', 'Review feedback', '--json']),
    [{ path: '/api/v1/tasks/fixture-id', method: 'PATCH', body: { title: 'Revised task', reason: 'Review feedback' } }])
  assert.deepEqual(await run(['req', 'update', 'fixture-id', '--status', 'approved', '--reason', 'Owner approved scope', '--json']),
    [{ path: '/api/v1/requirements/fixture-id', method: 'PATCH', body: { status: 'approved', reason: 'Owner approved scope' } }])
})

test('legacy updates omit audit reason and task status keeps its existing distinct route', async () => {
  assert.deepEqual((await run(['task', 'update', 'fixture-id', '--priority', 'high', '--json']))[0]!.body, { priority: 'high' })
  assert.deepEqual((await run(['req', 'update', 'fixture-id', '--priority', 'high', '--json']))[0]!.body, { priority: 'high' })
  const [status] = await run(['task', 'status', 'fixture-id', 'in_progress', '--reason', 'Starting work', '--json'])
  assert.ok(status)
  assert.equal(status.path, '/api/v1/tasks/fixture-id/status')
  assert.equal((status.body as { reason: string }).reason, 'Starting work')
  await assert.rejects(() => run(['task', 'update', 'fixture-id', '--status', 'done', '--reason', 'Do not bypass status guards']), /unknown option/)
})
