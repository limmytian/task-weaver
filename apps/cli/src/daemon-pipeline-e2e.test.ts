import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseDaemonPipelineConfig } from './daemon-pipeline-config.js'
import { runDaemonPipeline, type PipelineLaunchPlan } from './daemon-pipeline.js'
import {
  PipelineRuntimeStore,
  enqueuePipelineControl,
  readPipelineLogs,
  readPipelineState,
} from './daemon-pipeline-store.js'

const projectId = '00000000-0000-4000-8000-000000000601'

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`pipeline process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
}

function waitForOutput(child: ReturnType<typeof spawn>, pattern: RegExp, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for pipeline output ${pattern}`))
    }, timeoutMs)
    const onData = (chunk: string | Buffer) => {
      if (!pattern.test(chunk.toString())) return
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
    }
    child.stdout?.on('data', onData)
  })
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${message}`)
}

test('pipeline CLI starts a role, correlates logs, and drains it on SIGINT', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-cli-e2e-'))
  const home = join(root, 'home')
  const runtimeRoot = join(root, 'runs')
  const configPath = join(root, 'pipeline.yaml')
  await mkdir(home, { recursive: true })
  await writeFile(configPath, [
    'version: 1',
    `projectId: ${projectId}`,
    'roles:',
    '  executor: { enabled: false }',
    '  reviewer: { enabled: false }',
    '  merger: { workers: 1 }',
    'retry: { maxRestarts: 0 }',
    'limits: { controlPollMs: 100, shutdownGraceMs: 2000 }',
    'logging:',
    `  directory: ${JSON.stringify(runtimeRoot)}`,
    '  maxBytes: 1048576',
    '  maxFiles: 2',
  ].join('\n'), 'utf8')

  const statusReports: unknown[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/api/v1/auth/me') return sendJson(response, 200, { actor: { id: '00000000-0000-4000-8000-0000000000aa', type: 'agent' }, account: null, session: null })
    if (request.method === 'GET' && path === '/api/v1/daemons') return sendJson(response, 200, { items: [] })
    if (request.method === 'GET' && path === `/api/v1/projects/${projectId}/requirements`) return sendJson(response, 200, [])
    if (request.method === 'POST' && path === '/api/v1/daemons/register') {
      await readJson(request)
      return sendJson(response, 201, { config: { executionDelegationSupported: true, mode: 'polling', pollingIntervalMs: 50, pollingBackoffMax: 100 } })
    }
    if (request.method === 'POST' && /^\/api\/v1\/daemons\/[^/]+\/status$/.test(path)) {
      statusReports.push(await readJson(request))
      return sendJson(response, 200, { ok: true })
    }
    if (request.method === 'POST' && /^\/api\/v1\/daemons\/[^/]+\/heartbeat$/.test(path)) {
      await readJson(request)
      return sendJson(response, 200, { ok: true })
    }
    if (request.method === 'POST' && /^\/api\/v1\/daemons\/[^/]+\/apply-merge$/.test(path)) {
      await readJson(request)
      return sendJson(response, 200, { requirement: null, tasks: [], repositories: [] })
    }
    return sendJson(response, 404, { error: `Unhandled ${request.method} ${path}` })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm', join(process.cwd(), 'src/index.ts'),
      'daemon', 'pipeline', 'start', '--config', configPath,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TW_API_URL: `http://127.0.0.1:${address.port}`,
        TW_API_KEY: 'test-key',
        TW_CLIENT_ID: 'pipeline-e2e-client',
        TW_NODE_ID: 'pipeline-e2e-node',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exit = waitForExit(child, 20_000)
    await waitForOutput(child, /Starting merger instance/, 10_000)
    await waitFor(() => statusReports.some((report: any) => report.status === 'idle'), 'merger idle status')
    child.kill('SIGINT')
    const result = await exit

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /SIGINT received; draining/)
    assert.ok(statusReports.some((report: any) => report.status === 'idle'))
    assert.ok(statusReports.some((report: any) => report.status === 'offline'))
    const runId = (await readdir(runtimeRoot))[0]
    assert.ok(runId)
    const state = readPipelineState(runtimeRoot, runId)
    assert.equal(state.status, 'stopped')
    assert.equal(state.exitCode, 0)
    const logs = readPipelineLogs(runtimeRoot, runId)
    assert.ok(logs.some((event) => event.event === 'pipeline_started' && event.runId === runId))
    assert.ok(logs.some((event) => event.event === 'role_output' && event.role === 'merger'))
    assert.ok(logs.some((event) => event.event === 'pipeline_stopped' && event.durationMs === undefined))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline supervisor recovers one failed role while independently draining and restarting siblings', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-multirole-e2e-'))
  const marker = join(root, 'executor-started')
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: { executor: {}, reviewer: {}, merger: {} },
      retry: { maxRestarts: 2, initialBackoffMs: 10, maxBackoffMs: 20 },
      limits: { controlPollMs: 100, shutdownGraceMs: 2_000 },
      logging: { directory: root },
    })
    const stableScript = 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),10));setInterval(()=>{},1000)'
    const executorScript = [
      'const fs=require("node:fs");',
      `const marker=${JSON.stringify(marker)};`,
      'if(!fs.existsSync(marker)){fs.writeFileSync(marker,"started");process.exit(5)}',
      stableScript,
    ].join(';')
    const roles = ['executor', 'reviewer', 'merger'] as const
    const plan: PipelineLaunchPlan = {
      runId: '00000000-0000-4000-8000-000000000610',
      runMode: 'service',
      roles: roles.map((role, index) => ({
        role,
        instanceId: `00000000-0000-4000-8000-00000000061${index + 1}`,
        command: process.execPath,
        args: ['-e', role === 'executor' ? executorScript : stableScript],
        env: { ...process.env },
      })),
    }
    const store = new PipelineRuntimeStore(config, plan)
    const running = runDaemonPipeline(config, plan, { store, log: () => {} })
    await waitFor(() => {
      const executor = readPipelineState(root, plan.runId).roles.executor
      return executor?.status === 'running' && executor.restartCount === 1
    }, 'executor recovery')
    assert.equal(readPipelineState(root, plan.runId).roles.reviewer?.status, 'running')

    enqueuePipelineControl(root, plan.runId, { action: 'drain', role: 'reviewer' })
    await waitFor(() => readPipelineState(root, plan.runId).roles.reviewer?.status === 'stopped', 'reviewer drain')
    assert.equal(readPipelineState(root, plan.runId).roles.executor?.status, 'running')

    const mergerPid = readPipelineState(root, plan.runId).roles.merger?.pid
    enqueuePipelineControl(root, plan.runId, { action: 'restart', role: 'merger' })
    await waitFor(() => {
      const merger = readPipelineState(root, plan.runId).roles.merger
      return merger?.status === 'running' && merger.pid !== mergerPid
    }, 'merger restart')

    enqueuePipelineControl(root, plan.runId, { action: 'stop' })
    assert.equal(await running, 0)
    const logs = readPipelineLogs(root, plan.runId)
    assert.ok(logs.some((event) => event.event === 'role_restart_scheduled' && event.role === 'executor' && event.retry === 1))
    assert.ok(logs.some((event) => event.failureCode === 'role_exit_5'))
    assert.ok(logs.some((event) => event.event === 'control_received' && event.message === 'Applying drain to reviewer.'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two supervisors isolate six role processes through death, restart, and independent shutdown', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-multi-instance-'))
  const marker = join(root, 'pipeline-a-executor-started')
  try {
    const config = parseDaemonPipelineConfig({
      version: 1,
      projectId,
      roles: { executor: {}, reviewer: {}, merger: {} },
      retry: { maxRestarts: 1, initialBackoffMs: 10, maxBackoffMs: 10 },
      limits: { controlPollMs: 100, shutdownGraceMs: 1_000 },
      logging: { directory: root },
    })
    const stable = 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'
    const failOnce = [
      'const fs=require("node:fs")',
      `const marker=${JSON.stringify(marker)}`,
      'if(!fs.existsSync(marker)){fs.writeFileSync(marker,"started");process.exit(23)}',
      stable,
    ].join(';')
    const roles = ['executor', 'reviewer', 'merger'] as const
    const buildPlan = (suffix: 'a' | 'b', runId: string): PipelineLaunchPlan => ({
      runId,
      runMode: 'service',
      roles: roles.map((role, index) => ({
        role,
        instanceId: `00000000-0000-4000-8000-0000000007${suffix === 'a' ? '1' : '2'}${index + 1}`,
        command: process.execPath,
        args: ['-e', suffix === 'a' && role === 'executor' ? failOnce : stable],
        env: { ...process.env, TW_SHARED_PROJECT_ID: projectId },
      })),
    })
    const planA = buildPlan('a', '00000000-0000-4000-8000-000000000701')
    const planB = buildPlan('b', '00000000-0000-4000-8000-000000000702')
    const runningA = runDaemonPipeline(config, planA, {
      store: new PipelineRuntimeStore(config, planA), log: () => {},
    })
    const runningB = runDaemonPipeline(config, planB, {
      store: new PipelineRuntimeStore(config, planB), log: () => {},
    })
    await waitFor(() => {
      const a = readPipelineState(root, planA.runId)
      const b = readPipelineState(root, planB.runId)
      return roles.every((role) => a.roles[role]?.status === 'running')
        && roles.every((role) => b.roles[role]?.status === 'running')
        && a.roles.executor?.restartCount === 1
    }, 'both three-role supervisors to become healthy')

    const states = [readPipelineState(root, planA.runId), readPipelineState(root, planB.runId)]
    const pids = states.flatMap((state) => roles.map((role) => state.roles[role]?.pid))
      .filter((pid): pid is number => typeof pid === 'number')
    assert.equal(pids.length, 6)
    assert.equal(new Set(pids).size, 6)
    assert.equal(new Set([...planA.roles, ...planB.roles].map((role) => role.instanceId)).size, 6)

    enqueuePipelineControl(root, planA.runId, { action: 'stop' })
    assert.equal(await runningA, 0)
    assert.ok(roles.every((role) => readPipelineState(root, planB.runId).roles[role]?.status === 'running'))
    enqueuePipelineControl(root, planB.runId, { action: 'stop' })
    assert.equal(await runningB, 0)
    assert.ok(readPipelineLogs(root, planA.runId).some((event) =>
      event.event === 'role_restart_scheduled' && event.failureCode === 'role_exit_23'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pipeline CLI rejects invalid configuration and reports preflight failures before spawn', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-pipeline-failure-e2e-'))
  try {
    const invalidPath = join(root, 'invalid.json')
    const blockedPath = join(root, 'blocked.json')
    await writeFile(invalidPath, JSON.stringify({ version: 2, projectId, roles: {} }), 'utf8')
    await writeFile(blockedPath, JSON.stringify({
      version: 1,
      projectId,
      roles: {
        executor: { tools: ['task-weaver-missing-tool'] },
        reviewer: { enabled: false },
        merger: { enabled: false },
      },
      logging: { directory: join(root, 'runs') },
    }), 'utf8')
    const runCli = (args: string[]) => waitForExit(spawn(process.execPath, [
      '--import', 'tsx/esm', join(process.cwd(), 'src/index.ts'), ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, TW_API_URL: 'http://127.0.0.1:1', TW_API_KEY: 'test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }), 10_000)

    const invalid = await runCli(['daemon', 'pipeline', 'validate', '--config', invalidPath, '--json'])
    assert.equal(invalid.code, 1)
    assert.match(invalid.stderr, /version must be 1/)

    const blocked = await runCli(['daemon', 'pipeline', 'doctor', '--config', blockedPath, '--json'])
    assert.equal(blocked.code, 1)
    const result = JSON.parse(blocked.stdout)
    assert.equal(result.ready, false)
    assert.ok(result.checks.some((check: any) => check.failureCode === 'api_unavailable'))
    assert.ok(result.checks.some((check: any) => check.failureCode === 'ai_tool_unavailable'))
    assert.equal(await readFile(blockedPath, 'utf8').then((value) => Boolean(value)), true)
    assert.equal(await readdir(root).then((items) => items.includes('runs')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
