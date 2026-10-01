import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { registerAgentUsage } from './agent-usage.js'

test('usage CLI sends validated scopes and compact Ti reports without emitting credentials', async (t) => {
  const paths: string[] = []
  const bodies: unknown[] = []
  const server = createServer(async (req, res) => {
    paths.push(req.url!)
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        processId: 'fixture',
        revision: 1,
        summary: { completeness: 'partial' },
        inputTokens: null,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const oldUrl = process.env.TW_API_URL
  const oldKey = process.env.TW_API_KEY
  process.env.TW_API_URL = `http://127.0.0.1:${address.port}`
  process.env.TW_API_KEY = 'fixture-not-a-real-key'
  const output: string[] = []
  const oldLog = console.log
  console.log = (value: unknown) => {
    output.push(String(value))
  }
  t.after(() => {
    console.log = oldLog
    if (oldUrl === undefined) delete process.env.TW_API_URL
    else process.env.TW_API_URL = oldUrl
    if (oldKey === undefined) delete process.env.TW_API_KEY
    else process.env.TW_API_KEY = oldKey
  })
  const run = async (...args: string[]) => {
    const program = new Command()
    registerAgentUsage(program)
    await program.parseAsync(['node', 'tw', 'usage', ...args])
  }
  const project = '11111111-1111-4111-8111-111111111111'
  const task = '22222222-2222-4222-8222-222222222222'
  await run(
    'summary',
    '--project',
    project,
    '--task',
    task,
    '--since',
    '2026-10-02T00:00:00Z',
    '--json',
  )
  const query = new URL(paths[0]!, 'http://fixture')
  assert.equal(query.pathname, '/api/v1/agent-usage/summary')
  assert.equal(query.searchParams.get('projectId'), project)
  assert.equal(query.searchParams.get('taskId'), task)
  const directory = mkdtempSync(join(tmpdir(), 'tw-usage-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'usage.json')
  writeFileSync(
    file,
    JSON.stringify({
      processId: project,
      workerId: 'fixture-worker',
      attempt: 0,
      startedAt: '2026-10-02T00:00:00Z',
      outcome: 'running',
      revision: 1,
      summary: { completeness: 'partial', inputTokens: 0, model: 'multiple' },
    }),
  )
  await run('report-ti', task, '--file', file, '--json')
  assert.equal(paths[1], `/api/v1/pi-agent/runs/${task}/usage`)
  assert.equal((bodies[0] as any).summary.inputTokens, 0)
  assert.equal((bodies[0] as any).summary.outputTokens, null)
  writeFileSync(file, JSON.stringify({ transcript: 'must not be transmitted' }))
  await assert.rejects(run('report-ti', task, '--file', file))
  assert.equal(paths.length, 2)
  assert.ok(output.every((line) => !line.includes('fixture-not-a-real-key')))
})
