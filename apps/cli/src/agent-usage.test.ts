import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexUsageCollector, runMeteredAgent } from './agent-usage.js'
import type { ReportAgentUsageInput } from '@task-weaver/contracts'
const event = (input = 100, output = 10) =>
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: input,
      cached_input_tokens: 80,
      output_tokens: output,
    },
  }) + '\n'
test('fragmented cumulative snapshots and replay count once', () => {
  const c = new CodexUsageCollector()
  const data = Buffer.from(event() + event() + event(200, 20))
  for (let i = 0; i < data.length; i += 3) c.push(data.subarray(i, i + 3))
  assert.deepEqual(c.finish(true), {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: null,
    cacheSemantics: 'included',
    provider: 'unknown',
    model: 'unknown',
    completeness: 'complete',
  })
})
test('malformed and oversized lines preserve prior totals and mark partial', () => {
  for (const suffix of [
    '{broken\n',
    'x'.repeat(1024 * 1024 + 1) + '\n',
    event(90),
    '{"type":"turn.started"}\n',
  ]) {
    const c = new CodexUsageCollector()
    c.push(Buffer.from(event() + suffix))
    assert.equal(c.finish(true).completeness, 'partial')
    assert.equal(c.snapshot().inputTokens, 100)
  }
  const c = new CodexUsageCollector()
  c.push(Buffer.from(event().trim()))
  assert.equal(c.finish(false).completeness, 'partial')
  assert.equal(new CodexUsageCollector().finish(true).completeness, 'unknown')
})
test('capture happens before log truncation; a new process gets a new identity', async () => {
  const reports: ReportAgentUsageInput[] = []
  const report = async (body: ReportAgentUsageInput) => {
    reports.push(body)
  }
  const scope = {
    daemonId: 'daemon',
    projectId: 'project',
    requirementId: 'req',
    agent: 'codex',
    phase: 'review' as const,
  }
  const script = `process.stdout.write(${JSON.stringify(event())}); process.stdout.write(JSON.stringify({type:'item.completed',item:{text:'x'.repeat(3000)}})+'\\n')`
  const result = await runMeteredAgent(
    process.execPath,
    ['-e', script],
    { maxOutputBytes: 10 },
    scope,
    report,
  )
  assert.equal(result.ok, true)
  assert.equal(result.outputTruncated, true)
  assert.equal(reports.at(-1)?.summary.inputTokens, 100)
  assert.equal(reports.at(-1)?.summary.completeness, 'complete')
  await runMeteredAgent(
    process.execPath,
    [
      '-e',
      `process.stdout.write(${JSON.stringify(event())}); process.exitCode=1`,
    ],
    {},
    scope,
    report,
  )
  assert.notEqual(reports[0]?.processId, reports[2]?.processId)
  assert.equal(reports.at(-1)?.summary.completeness, 'partial')
})
test('collection failures and unsupported sources do not alter execution results', async () => {
  const result = await runMeteredAgent(
    process.execPath,
    ['-e', 'process.exitCode=7'],
    {},
    {
      daemonId: 'd',
      projectId: 'p',
      requirementId: 'r',
      agent: 'claude',
      phase: 'execution',
    },
    async () => {
      throw new Error('offline')
    },
  )
  assert.equal(result.status, 7)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 250)
  const reports: ReportAgentUsageInput[] = []
  await runMeteredAgent(
    process.execPath,
    [
      '-e',
      `process.stdout.write(${JSON.stringify(event())}); setInterval(()=>{},1000)`,
    ],
    { signal: controller.signal, killGraceMs: 10 },
    {
      daemonId: 'd',
      projectId: 'p',
      requirementId: 'r',
      agent: 'codex',
      phase: 'execution',
    },
    async (b) => {
      reports.push(b)
    },
  )
  assert.equal(reports.at(-1)?.outcome, 'cancelled')
  assert.equal(reports.at(-1)?.summary.completeness, 'partial')
})

test('independently reported counters survive incomplete structured events', () => {
  const c = new CodexUsageCollector()
  c.push(
    Buffer.from(
      JSON.stringify({
        type: 'turn.completed',
        usage: { output_tokens: 12, input_tokens: -1 },
      }),
    ),
  )
  const result = c.finish(true)
  assert.equal(result.inputTokens, null)
  assert.equal(result.outputTokens, 12)
  assert.equal(result.completeness, 'partial')
})

test('registration latency does not delay spawning and spawn failures are not process runs', async () => {
  let spawned = false
  let releaseRegistration!: () => void
  const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve })
  const reports: ReportAgentUsageInput[] = []
  const scope = {
    daemonId: 'd',
    projectId: 'p',
    requirementId: 'r',
    agent: 'codex',
    phase: 'execution' as const,
  }
  const result = await runMeteredAgent(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(event())})`],
    {
      onSpawn: () => {
        spawned = true
      },
      onStdout: () => releaseRegistration(),
    },
    scope,
    async (body) => {
      reports.push(body)
      await registrationGate
    },
  )
  assert.equal(spawned, true)
  assert.equal(result.ok, true)
  assert.equal(reports.at(-1)?.summary.inputTokens, 100)
  const missing = await runMeteredAgent(
    '/nonexistent-task-weaver-usage-fixture',
    [],
    {},
    scope,
    async (body) => {
      reports.push(body)
    },
  )
  assert.equal(missing.ok, false)
  assert.equal(reports.length, 2, 'No process was started for a spawn error')
})
