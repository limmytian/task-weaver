import assert from 'node:assert'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PipelineConfigError,
  loadDaemonPipelineConfig,
  parseDaemonPipelineConfig,
} from './daemon-pipeline-config.js'
import {
  buildPipelineLaunchPlan,
  buildPipelineRoleArgs,
  formatPipelineHealth,
  resolvePipelineEnvironment,
  runDaemonPipeline,
} from './daemon-pipeline.js'
import { runPipelinePreflight } from './daemon-pipeline-preflight.js'
import {
  PipelineRuntimeStore,
  enqueuePipelineControl,
  listPipelineStates,
  readPipelineLogs,
  readPipelineState,
} from './daemon-pipeline-store.js'

const projectId = '00000000-0000-4000-8000-000000000001'

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${message}`)
}

function minimalConfig() {
  return parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: {
      executor: { tools: ['codex'], models: { strong: 'gpt-5.6' }, reasoningEffort: { strong: 'high' } },
      reviewer: { checks: ['pnpm typecheck'], skipAiReview: true, postForgeSummary: true },
      merger: {},
    },
  })
}

test('pipeline configuration loads YAML, applies defaults, and resolves prompt files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-config-'))
  try {
    const configPath = join(root, 'pipeline.yaml')
    await writeFile(configPath, [
      'version: 1',
      `projectId: ${projectId}`,
      'runMode: service',
      'roles:',
      '  executor:',
      '    workers: 2',
      '    tools: [codex]',
      '    promptFiles: [worker.md]',
      '  reviewer:',
      '    checks: [pnpm typecheck]',
      '  merger: {}',
      'environment:',
      '  GITHUB_TOKEN:',
      '    fromEnv: TW_GITHUB_TOKEN',
      '    required: false',
    ].join('\n'), 'utf8')

    const config = loadDaemonPipelineConfig(configPath)
    assert.equal(config.version, 1)
    assert.equal(config.runMode, 'service')
    assert.equal(config.roles.executor.workers, 2)
    assert.deepEqual(config.roles.executor.promptFiles, [join(root, 'worker.md')])
    assert.deepEqual(config.retry, {
      maxRestarts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline configuration rejects incompatible versions and unsafe merge combinations', () => {
  assert.throws(() => parseDaemonPipelineConfig({
    version: 2,
    projectId,
    roles: { executor: {}, reviewer: {}, merger: {} },
  }), (error: unknown) => error instanceof PipelineConfigError && /version must be 1/.test(error.message))

  assert.throws(() => parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: { executor: {}, reviewer: {}, merger: { enabled: true } },
    mergePolicy: { mode: 'manual' },
  }), /merger must be disabled/)

  assert.throws(() => parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: { executor: {}, reviewer: {}, merger: {} },
    limits: { controlPollMs: 25 },
  }), /controlPollMs must be an integer from 100 to 10000/)
})

test('pipeline role arguments preserve workers, models, checks, prompts, and merge base', () => {
  const config = minimalConfig()
  const executorArgs = buildPipelineRoleArgs(config, 'executor', '00000000-0000-4000-8000-000000000101')
  assert.deepEqual(executorArgs.slice(0, 2), ['daemon', 'start'])
  assert.ok(executorArgs.includes('codex'))
  assert.ok(executorArgs.includes('strong:gpt-5.6'))
  assert.ok(executorArgs.includes('strong:high'))

  const reviewerArgs = buildPipelineRoleArgs(config, 'reviewer', '00000000-0000-4000-8000-000000000102')
  assert.ok(reviewerArgs.includes('pnpm typecheck'))
  assert.ok(reviewerArgs.includes('--skip-ai-review'))
  assert.ok(reviewerArgs.includes('--post-forge-summary'))
  assert.ok(reviewerArgs.includes('main'))

  const mergerArgs = buildPipelineRoleArgs(config, 'merger', '00000000-0000-4000-8000-000000000103')
  assert.deepEqual(mergerArgs.slice(0, 2), ['daemon', 'merge'])
  assert.ok(mergerArgs.includes('main'))
  assert.deepEqual(mergerArgs.slice(-2), ['--mode', 'direct'])

  const providerConfig = parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: {
      executor: {},
      reviewer: { checks: ['pnpm typecheck'] },
      merger: { enabled: true },
    },
    mergePolicy: { mode: 'provider' },
  })
  assert.deepEqual(
    buildPipelineRoleArgs(providerConfig, 'merger', '00000000-0000-4000-8000-000000000104').slice(-2),
    ['--mode', 'provider'],
  )
})

test('pipeline launch plan assigns independent role identities and run metadata', () => {
  const ids = [
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203',
  ]
  const plan = buildPipelineLaunchPlan(minimalConfig(), {
    runId: '00000000-0000-4000-8000-000000000200',
    entrypoint: '/opt/tw/dist/index.js',
    runtimeCommand: '/usr/bin/node',
    runtimeArgs: [],
    environment: { PATH: '/bin' },
    generateId: () => ids.shift()!,
  })

  assert.deepEqual(plan.roles.map((role) => role.instanceId), [
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203',
  ])
  assert.equal(new Set(plan.roles.map((role) => role.instanceId)).size, 3)
  assert.equal(plan.roles[0]?.env.TW_DAEMON_PIPELINE_RUN_ID, plan.runId)
  assert.equal(plan.roles[1]?.env.TW_DAEMON_PIPELINE_ROLE, 'reviewer')
  assert.deepEqual(plan.roles[2]?.args.slice(0, 3), ['/opt/tw/dist/index.js', 'daemon', 'merge'])
})

test('pipeline environment references copy only configured source values and enforce required refs', () => {
  const config = parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: { executor: {}, reviewer: { enabled: false }, merger: { enabled: false } },
    environment: {
      GITHUB_TOKEN: { fromEnv: 'TW_GITHUB_TOKEN', required: true },
      OPTIONAL_VALUE: { fromEnv: 'TW_OPTIONAL_VALUE', required: false },
    },
  })
  assert.equal(resolvePipelineEnvironment(config, { TW_GITHUB_TOKEN: 'secret' }).GITHUB_TOKEN, 'secret')
  assert.throws(() => resolvePipelineEnvironment(config, {}), /required environment references are missing/)
})

test('pipeline configuration fails closed when review has no effective policy', () => {
  assert.throws(() => parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: {
      executor: {},
      reviewer: { skipAiReview: true },
      merger: {},
    },
  }), /needs checks, AI review, or an explicit allowUnreviewed override/)
})

test('pipeline supervisor reports health and fails after a role exhausts restarts', async () => {
  const config = parseDaemonPipelineConfig({
    version: 1,
    projectId,
    roles: {
      executor: {},
      reviewer: { enabled: false },
      merger: { enabled: false },
    },
    retry: { maxRestarts: 0 },
  })
  const launch = {
    role: 'executor' as const,
    instanceId: '00000000-0000-4000-8000-000000000301',
    command: process.execPath,
    args: ['-e', 'process.exit(7)'],
    env: { ...process.env },
  }
  const logs: string[] = []
  const exitCode = await runDaemonPipeline(config, {
    runId: '00000000-0000-4000-8000-000000000300',
    runMode: 'foreground',
    roles: [launch],
  }, { log: (message) => logs.push(message) })

  assert.equal(exitCode, 7)
  assert.ok(logs.some((message) => message.includes('Health: executor=running')))
  assert.ok(logs.some((message) => message.includes('exhausted 0 restart(s)')))
  assert.equal(formatPipelineHealth([launch], new Map(), new Map()), 'executor=stopped restarts=0')
})

test('pipeline runtime store persists state, control commands, filtered logs, and bounded rotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-store-'))
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: { executor: {}, reviewer: { enabled: false }, merger: { enabled: false } },
      logging: { directory: root, maxBytes: 65_536, maxFiles: 2 },
    })
    const plan = buildPipelineLaunchPlan(config, {
      runId: '00000000-0000-4000-8000-000000000400',
      entrypoint: '/opt/tw/index.js',
      runtimeCommand: '/usr/bin/node',
      runtimeArgs: [],
      environment: {},
      generateId: () => '00000000-0000-4000-8000-000000000401',
    })
    const store = new PipelineRuntimeStore(config, plan)
    store.updateRun({ status: 'running' })
    store.updateRole('executor', { status: 'running', pid: 1234 })
    store.append({
      event: 'task_started',
      level: 'info',
      message: 'task started',
      role: 'executor',
      workerIndex: 2,
      requirementId: 'req-1',
      taskId: 'task-1',
      repository: 'example/repo',
    })

    const command = enqueuePipelineControl(root, plan.runId, { action: 'pause', role: 'executor' })
    assert.equal(store.takeControlCommands()[0]?.id, command.id)
    assert.equal(readPipelineState(root, plan.runId).roles.executor?.pid, 1234)
    assert.equal(listPipelineStates(root)[0]?.runId, plan.runId)
    assert.equal(readPipelineLogs(root, plan.runId, { taskId: 'task-1' })[0]?.workerIndex, 2)

    for (let index = 0; index < 20; index += 1) {
      store.append({ event: 'large', level: 'info', message: `${index}:${'x'.repeat(8_000)}` })
    }
    const files = await readdir(store.runDirectory)
    assert.ok(files.filter((name) => name.startsWith('events.jsonl')).length <= 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline preflight verifies API compatibility, tools, models, checks, and worktree readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-preflight-'))
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: {
        executor: { tools: ['codex'], models: { strong: 'gpt-5.6' }, reasoningEffort: { strong: 'high' } },
        reviewer: { enabled: false },
        merger: { enabled: false },
      },
      logging: { directory: root },
    })
    const requestedPaths: string[] = []
    const result = await runPipelinePreflight(config, {
      apiGet: async (path) => {
        requestedPaths.push(path)
        return [] as never
      },
      runTool: async () => ({ ok: true, status: 0, timedOut: false, stderr: '' }),
      cliConfig: { apiUrl: 'http://tw.test' },
      worktreeRoot: join(root, 'worktrees'),
      environment: { PATH: '/bin' },
    })

    assert.equal(result.ready, true)
    assert.deepEqual(requestedPaths, [
      '/api/v1/daemons',
      `/api/v1/projects/${projectId}/requirements`,
    ])
    assert.ok(result.checks.some((check) => check.name === 'ai-tool' && check.status === 'pass'))
    assert.ok(result.checks.some((check) => check.name === 'worktree-root' && check.status === 'pass'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline preflight fails before acquisition when API and executor are unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-preflight-fail-'))
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: { executor: { tools: ['missing'] }, reviewer: { enabled: false }, merger: { enabled: false } },
      logging: { directory: root },
    })
    const result = await runPipelinePreflight(config, {
      apiGet: async () => { throw new Error('connection refused') },
      runTool: async () => ({ ok: false, status: null, timedOut: false, errorCode: 'ENOENT', stderr: '' }),
      cliConfig: { apiUrl: 'http://tw.test' },
      worktreeRoot: join(root, 'worktrees'),
      environment: { PATH: '' },
    })
    assert.equal(result.ready, false)
    assert.ok(result.checks.some((check) => check.failureCode === 'api_unavailable'))
    assert.ok(result.checks.some((check) => check.failureCode === 'ai_tool_unavailable'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline supervisor applies role-aware pause, resume, restart, and graceful stop controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-controls-'))
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: { executor: {}, reviewer: { enabled: false }, merger: { enabled: false } },
      retry: { maxRestarts: 0 },
      limits: { controlPollMs: 100, shutdownGraceMs: 1_000 },
      logging: { directory: root },
    })
    const launch = {
      role: 'executor' as const,
      instanceId: '00000000-0000-4000-8000-000000000501',
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),10));setInterval(()=>{},1000)'],
      env: { ...process.env },
    }
    const plan = {
      runId: '00000000-0000-4000-8000-000000000500',
      runMode: 'foreground' as const,
      roles: [launch],
    }
    const store = new PipelineRuntimeStore(config, plan)
    const running = runDaemonPipeline(config, plan, { store, log: () => {} })

    await waitFor(() => readPipelineState(root, plan.runId).roles.executor?.status === 'running', 'executor start')
    const firstPid = readPipelineState(root, plan.runId).roles.executor?.pid
    enqueuePipelineControl(root, plan.runId, { action: 'pause', role: 'executor' })
    await waitFor(() => readPipelineState(root, plan.runId).roles.executor?.status === 'paused', 'executor pause')

    enqueuePipelineControl(root, plan.runId, { action: 'resume', role: 'executor' })
    await waitFor(() => {
      const role = readPipelineState(root, plan.runId).roles.executor
      return role?.status === 'running' && role.pid !== firstPid
    }, 'executor resume')
    const resumedPid = readPipelineState(root, plan.runId).roles.executor?.pid

    enqueuePipelineControl(root, plan.runId, { action: 'restart', role: 'executor' })
    await waitFor(() => {
      const role = readPipelineState(root, plan.runId).roles.executor
      return role?.status === 'running' && role.pid !== resumedPid
    }, 'executor restart')

    enqueuePipelineControl(root, plan.runId, { action: 'stop' })
    assert.equal(await running, 0)
    assert.equal(readPipelineState(root, plan.runId).status, 'stopped')
    const controls = readPipelineLogs(root, plan.runId, { event: 'control_received' })
    assert.deepEqual(controls.map((event) => event.message), [
      'Applying pause to executor.',
      'Applying resume to executor.',
      'Applying restart to executor.',
      'Applying stop to all roles.',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
