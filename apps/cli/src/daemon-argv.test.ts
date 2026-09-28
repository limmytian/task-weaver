import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildArgv,
  formatEligibilityDiagnostics,
  inspectTools,
  loadExtraWorkerPrompt,
  parseThinkMappings,
  preflightExecutorTools,
  resolveDaemonProcessIdentity,
  selectExecutorTool,
  shouldExecutorWorkerPoll,
} from './commands/daemon.js'

test('executor selection follows installed tool order and server eligibility', () => {
  assert.equal(
    selectExecutorTool(['agy', 'codex'], ['executor:claude', 'executor:codex'], 'codex'),
    'codex',
  )
  assert.equal(
    selectExecutorTool(['agy', 'codex'], ['tool:claude', 'tool:codex']),
    'codex',
  )
  assert.equal(selectExecutorTool(['agy', 'codex'], []), 'agy')
  assert.equal(selectExecutorTool(['agy'], ['executor:codex']), null)
})

test('executor preflight filters spawn failures before daemon registration', async () => {
  const attempts: string[] = []
  const result = await preflightExecutorTools(
    ['missing', 'codex', 'codex'],
    async (command) => {
      attempts.push(command)
      return command === 'codex'
        ? { status: 0, timedOut: false }
        : { status: null, timedOut: false, errorCode: 'ENOENT' }
    },
  )

  assert.deepEqual(attempts, ['missing', 'codex'])
  assert.deepEqual(result.runnable, ['codex'])
  assert.deepEqual(result.unavailable, [{ tool: 'missing', reason: 'spawn failed (ENOENT)' }])
})

test('--once assigns the daemon-wide acquisition slot to worker zero only', () => {
  assert.equal(shouldExecutorWorkerPoll(true, 0), true)
  assert.equal(shouldExecutorWorkerPoll(true, 1), false)
  assert.equal(shouldExecutorWorkerPoll(false, 1), true)
})

test('eligibility diagnostics render normalized counts deterministically', () => {
  assert.equal(formatEligibilityDiagnostics({
    candidateCount: 250,
    examinedCount: 200,
    runnableCount: 0,
    selectedCount: 0,
    truncated: true,
    skipCounts: {
      status: 0,
      dependency: 4,
      claim: 2,
      slice_order: 0,
      capability: 7,
      model_tier: 0,
      retry_time: 1,
      policy: 0,
    },
  }), '250 candidates, 0 runnable; examined 200/250; skipped dependency=4, claim=2, capability=7, retry_time=1')
})

test('daemon roles get distinct process IDs while retaining one actor identity', () => {
  const ids = [
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000103',
  ]
  const generateId = () => ids.shift()!
  const config = { actorId: 'operator-agent', clientId: 'cli-client' }
  const env = {}
  const now = () => new Date('2026-07-23T12:00:00.000Z')

  const executor = resolveDaemonProcessIdentity('executor', undefined, config, env, generateId, now)
  const reviewer = resolveDaemonProcessIdentity('reviewer', undefined, config, env, generateId, now)
  const merger = resolveDaemonProcessIdentity('merger', undefined, config, env, generateId, now)

  assert.deepEqual(
    [executor.instanceId, reviewer.instanceId, merger.instanceId],
    [
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ],
  )
  assert.deepEqual(
    [executor.actorId, reviewer.actorId, merger.actorId],
    ['operator-agent', 'operator-agent', 'operator-agent'],
  )
})

test('daemon identity honors explicit and role-scoped configured IDs', () => {
  const explicitId = '00000000-0000-4000-8000-000000000111'
  const envId = '00000000-0000-4000-8000-000000000112'
  const configId = '00000000-0000-4000-8000-000000000113'
  const config = {
    clientId: 'stable-client',
    daemonInstanceIds: { merger: configId },
  }

  assert.equal(
    resolveDaemonProcessIdentity('executor', explicitId, config, {
      TW_DAEMON_EXECUTOR_ID: envId,
    }).instanceId,
    explicitId,
  )
  assert.equal(
    resolveDaemonProcessIdentity('reviewer', undefined, config, {
      TW_DAEMON_REVIEWER_ID: envId,
    }).instanceId,
    envId,
  )
  assert.equal(
    resolveDaemonProcessIdentity('merger', undefined, config, {}).instanceId,
    configId,
  )
  assert.equal(
    resolveDaemonProcessIdentity('merger', undefined, config, {}).actorId,
    'stable-client',
  )
})

test('codex argv includes model and reasoning effort before the prompt', () => {
  const prompt = 'finish the requirement'
  const argv = buildArgv('codex', prompt, '/tmp/worktree', 'gpt-5.5', 'high')

  assert.deepEqual(argv.slice(0, 2), ['exec', '--dangerously-bypass-approvals-and-sandbox'])
  assert.equal(argv.at(-1), prompt)
  assert.ok(argv.includes('--model'))
  assert.ok(argv.includes('gpt-5.5'))
  assert.ok(argv.includes('-c'))
  assert.ok(argv.includes('model_reasoning_effort="high"'))
})

test('agy argv includes dangerously-skip-permissions, model, and effort flags', () => {
  const prompt = 'finish the requirement'
  const argv = buildArgv('agy', prompt, '/tmp/worktree', 'gemini-2.5-pro', 'high')

  assert.deepEqual(argv, ['--dangerously-skip-permissions', '--model', 'gemini-2.5-pro', '--effort', 'high', '-p', prompt])
})

test('non-codex argv ignores model and reasoning effort', () => {
  const prompt = 'finish the requirement'
  const argv = buildArgv('fake-agent', prompt, '/tmp/worktree', 'gpt-5.5', 'high')

  assert.deepEqual(argv, [prompt])
})

test('inspectTools reports installed, status, and path for known tools', async () => {
  const reports = await inspectTools(['agy', 'missing-tool'], async (command) => {
    return command === 'agy'
      ? { status: 0, timedOut: false }
      : { status: null, timedOut: false, errorCode: 'ENOENT' }
  })

  const agyReport = reports.find((r) => r.tool === 'agy')
  const missingReport = reports.find((r) => r.tool === 'missing-tool')

  assert.ok(agyReport)
  assert.ok(missingReport)
  assert.equal(missingReport.installed, false)
  assert.equal(missingReport.status, 'not_found')
})

test('think mappings validate model tiers and codex reasoning efforts', () => {
  assert.deepEqual(parseThinkMappings(['fast:low', 'standard:medium', 'strong:xhigh']), {
    fast: 'low',
    standard: 'medium',
    strong: 'xhigh',
  })
  assert.throws(() => parseThinkMappings(['urgent:high']), /Invalid --think mapping/)
  assert.throws(() => parseThinkMappings(['strong:extreme']), /Invalid --think mapping/)
})

test('extra worker prompts merge inline text and local files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-extra-prompt-'))
  try {
    const promptFile = join(root, 'worker.md')
    await writeFile(promptFile, 'Prefer local fixtures over network calls.\n', 'utf8')

    const prompt = loadExtraWorkerPrompt({
      prompt: ['Run the narrowest useful checks.'],
      promptFile: [promptFile],
    })

    assert.match(prompt, /Run the narrowest useful checks/)
    assert.match(prompt, /Prefer local fixtures over network calls/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
