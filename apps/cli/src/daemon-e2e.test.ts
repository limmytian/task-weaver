import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

type AgentMode = 'happy' | 'no-change' | 'push-failure' | 'partial-retry' | 'non-zero' | 'no-finalize' | 'slow' | 'delegation-unavailable' | 'human-key'

type ScenarioResult = {
  applyCount: number
  releaseCount: number
  requirement: Record<string, any>
  executionSlice: Record<string, any>
  tasks: Array<Record<string, any>>
  comments: Array<{ taskId: string; content: string }>
  statusReports: any[]
  progressReports: Array<Record<string, any>>
  reconcileReports: Array<Record<string, any>>
  exitCode: number | null
  stdout: string
  stderr: string
  branchPushed: boolean
  branchFile: string | null
  delivery: Record<string, any>
  secondaryBranchPushed: boolean
  secondaryBranchFile: string | null
  secondaryDelivery: Record<string, any>
  firstCycleDeliveryStatus?: string
  firstCycleSecondaryStatus?: string
  secondaryCommitAfterFirstCycle?: string
  secondaryCommitAfterRetry?: string
}

function runGit(args: string[], cwd?: string, allowFailure = false): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (!allowFailure) {
    assert.equal(
      result.status,
      0,
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`daemon process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
}

function waitForOutput(child: ReturnType<typeof spawn>, pattern: RegExp, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for daemon output ${pattern}`))
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

async function writeFakeTools(bin: string, mode: AgentMode, taskIds: string[], badRemote: string): Promise<void> {
  const fakeAgent = join(bin, 'fake-agent')
  await writeFile(
    fakeAgent,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

(async () => {
  if (process.argv.includes('--version')) {
    process.stdout.write('fake-agent 1.0.0\\n');
    return;
  }
  if (!/^twb_[0-9a-f]{64}$/.test(process.env.TW_API_KEY || '')) {
    throw new Error('daemon child must not inherit the configured API key');
  }
  const mode = ${JSON.stringify(mode)};
  const allTaskIds = ${JSON.stringify(taskIds)};
  const taskIds = allTaskIds.filter(id => id === process.env.TW_TASK_ID);
  const isLastTask = process.env.TW_TASK_ID === allTaskIds.at(-1);
  const partialRetryMarker = join(process.cwd(), '.partial-retry-cycle');
  const firstPartialRetryCycle = mode === 'partial-retry' && !existsSync(partialRetryMarker);
  if (firstPartialRetryCycle && isLastTask) writeFileSync(partialRetryMarker, 'started\\n');
  if (mode === 'non-zero') process.exit(7);
  if (mode === 'slow') {
    process.stdout.write('fake-agent-ready\\n');
    await new Promise(() => { setInterval(() => {}, 1000); });
  }

  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'repository-manifest.json'), 'utf8'));
  const repositoryCwds = manifest.repositories.map((repository) => join(process.cwd(), repository.relativePath));
  if (mode !== 'no-change' && mode !== 'no-finalize') {
    for (const repositoryCwd of repositoryCwds) {
      writeFileSync(join(repositoryCwd, 'daemon-output.txt'), \`\${mode} fake-agent completed the daemon path\\n\`);
    }
  }

  if (isLastTask && (mode === 'push-failure' || firstPartialRetryCycle)) {
    const badRemote = ${JSON.stringify(badRemote)};
    const repositoryCwd = repositoryCwds[0];
    const remote = spawnSync('git', ['remote', 'set-url', 'origin', badRemote], { cwd: repositoryCwd, encoding: 'utf8' });
    if (remote.status !== 0) {
      throw new Error(\`failed to poison origin remote: \${remote.stderr || remote.stdout}\`);
    }
  }

  if (mode === 'no-finalize') return;

  const apiUrl = process.env.TW_API_URL;
  for (const taskId of taskIds) {
    const res = await fetch(\`\${apiUrl}/api/v1/tasks/\${taskId}/status\`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TW_API_KEY },
      body: JSON.stringify({ status: 'done', reason: \`fake-agent completed \${taskId}\`, force: false }),
    });
    if (!res.ok) throw new Error(\`status update failed for \${taskId}: HTTP \${res.status}\`);
  }
})().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
`,
    'utf8',
  )
  await chmod(fakeAgent, 0o755)

  const fakeGh = join(bin, 'gh')
  await writeFile(fakeGh, '#!/bin/sh\necho "gh unavailable in daemon e2e test" >&2\nexit 127\n', 'utf8')
  await chmod(fakeGh, 0o755)
}

async function createGitFixture(
  root: string,
  mode: AgentMode,
  taskIds: string[],
): Promise<{ home: string; bin: string; remote: string; secondaryRemote: string }> {
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const seed = join(root, 'seed')
  const remote = join(root, 'remote.git')
  const secondaryRemote = join(root, 'secondary-remote.git')
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(seed, { recursive: true })

  runGit(['init'], seed)
  runGit(['checkout', '-b', 'main'], seed)
  runGit(['config', 'user.name', 'Task Weaver Test'], seed)
  runGit(['config', 'user.email', 'task-weaver@example.test'], seed)
  await writeFile(join(seed, 'README.md'), '# Daemon E2E\n', 'utf8')
  runGit(['add', 'README.md'], seed)
  runGit(['commit', '-m', 'seed'], seed)
  runGit(['init', '--bare', remote])
  runGit(['remote', 'add', 'origin', remote], seed)
  runGit(['push', '-u', 'origin', 'main'], seed)
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  runGit(['init', '--bare', secondaryRemote])
  runGit(['remote', 'set-url', 'origin', secondaryRemote], seed)
  runGit(['push', '-u', 'origin', 'main'], seed)
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], secondaryRemote)
  await writeFile(
    join(home, '.gitconfig'),
    '[credential]\n\thelper = store\n[user]\n\tname = Task Weaver Test\n\temail = task-weaver@example.test\n',
    'utf8',
  )
  await writeFakeTools(bin, mode, taskIds, join(root, 'missing-remote.git'))

  return { home, bin, remote, secondaryRemote }
}

async function runDaemonScenario(mode: AgentMode, workers = 1): Promise<ScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), `tw-daemon-${mode}-`))
  const projectId = '00000000-0000-4000-8000-0000000000f1'
  const daemonId = '00000000-0000-4000-8000-0000000000da'
  const requirementId = randomUUID()
  const executionSliceId = randomUUID()
  const branchName = `req/daemon-${mode}`
  const tasks = [
    {
      id: randomUUID(),
      projectId,
      requirementId,
      executionSliceId,
      title: 'Active daemon task',
      description: 'Active task',
      status: 'todo',
      priority: 'high',
      tags: null,
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    },
    {
      id: randomUUID(),
      projectId,
      requirementId,
      executionSliceId,
      title: 'Remaining daemon task',
      description: 'Remaining task',
      status: 'todo',
      priority: 'urgent',
      tags: null,
      createdAt: '2026-07-05T00:00:01.000Z',
      updatedAt: '2026-07-05T00:00:01.000Z',
    },
  ]
  const requirement = {
    id: requirementId,
    projectId,
    title: 'True daemon execution E2E smoke',
    description: 'Fake daemon lane',
    status: 'approved',
    priority: 'high',
    modelTier: 'strong',
    branchName,
  }
  const executionSlice = {
    id: executionSliceId,
    requirementId,
    title: 'Fake-agent daemon E2E',
    description: 'Build the fake tool/git fixture and validate the daemon path.',
    orderIndex: 1,
    modelTier: 'strong',
    status: 'todo',
    resultSummary: null as string | null,
    tasks,
  }
  const { home, bin, remote, secondaryRemote } = await createGitFixture(root, mode, tasks.map((task) => task.id))
  const repositoryId = '00000000-0000-4000-8000-0000000000e1'
  const delivery = {
    id: '00000000-0000-4000-8000-0000000000d1',
    requirementId,
    repositoryId,
    baseBranch: 'main',
    workingBranch: branchName,
    deliveryStatus: 'pending',
    manifestVersion: null,
    retryCount: 0,
    retryRole: null,
    resumeOperation: null,
    operationCheckpoints: {},
  }
  const repository = {
    id: repositoryId,
    displayName: 'Daemon E2E Repository',
    canonicalKey: 'local.test/task-weaver/daemon-e2e',
    provider: 'generic',
    host: 'local.test',
    namespace: 'task-weaver',
    name: 'daemon-e2e',
    defaultBranch: 'main',
    sshCloneUrl: null,
    httpsCloneUrl: pathToFileURL(remote).href,
    authPolicy: {
      allowedTransports: ['https'],
      preferredTransport: 'https',
      allowedOperations: ['read', 'push'],
      allowNativeDefault: true,
      revision: 1,
    },
  }
  const secondaryRepositoryId = '00000000-0000-4000-8000-0000000000e2'
  const secondaryDelivery = {
    id: '00000000-0000-4000-8000-0000000000d2',
    requirementId,
    repositoryId: secondaryRepositoryId,
    baseBranch: 'main',
    workingBranch: branchName,
    deliveryStatus: 'pending',
    manifestVersion: null,
    retryCount: 0,
    retryRole: null,
    resumeOperation: null,
    operationCheckpoints: {},
  }
  const secondaryRepository = {
    ...repository,
    id: secondaryRepositoryId,
    displayName: 'Secondary Daemon E2E Repository',
    canonicalKey: 'secondary.local/task-weaver/daemon-e2e-secondary',
    host: 'secondary.local',
    name: 'daemon-e2e-secondary',
    httpsCloneUrl: pathToFileURL(secondaryRemote).href,
  }
  const comments: Array<{ taskId: string; content: string }> = []
  const statusReports: any[] = []
  const progressReports: any[] = []
  const reconcileReports: any[] = []
  let applyCount = 0
  let releaseCount = 0
  const maxApplications = mode === 'partial-retry' ? 2 : 1

  const requirementPayload = () => ({
    ...requirement,
    tasks,
    executionSlices: [{ ...executionSlice, tasks }],
  })
  const slicePayload = () => ({ ...executionSlice, tasks })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/api/v1/auth/me') return sendJson(res, 200, { actor: { id: '00000000-0000-4000-8000-0000000000aa', type: mode === 'human-key' ? 'human' : 'agent' }, account: null, session: null })

    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/delegations`) {
      assert.equal(req.headers.authorization, 'Bearer test-key')
      const body = await readJson(req)
      return sendJson(res, 201, { token: `twd_${'a'.repeat(64)}`, delegation: {
        id: randomUUID(), parentCredentialId: randomUUID(), delegatorActorId: '00000000-0000-4000-8000-0000000000aa',
        initiator: { id: '00000000-0000-4000-8000-0000000000aa', type: 'agent' }, executorActorId: '00000000-0000-4000-8000-0000000000aa',
        projectId, requirementId: body.requirementId, taskIds: [body.taskId], repositoryIds: [],
        runId: body.runId, purpose: 'execute', leaseGeneration: body.leaseGeneration, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } })
    }
    if (req.method === 'DELETE' && path.startsWith(`/api/v1/daemons/${daemonId}/delegations/`)) return sendJson(res, 200, { revoked: true })

    if (req.method === 'POST' && path === '/api/v1/daemons/register') {
      await readJson(req)
      return sendJson(res, 201, {
        id: daemonId,
        status: 'idle',
        config: { executionDelegationSupported: mode !== 'delegation-unavailable', mode: 'polling', pollingIntervalMs: 20, pollingBackoffMax: 50 },
      })
    }

    if (req.method === 'POST' && path === '/api/v1/schedules/acquire-due') {
      await readJson(req)
      return sendJson(res, 200, { items: [] })
    }

    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/status`) {
      statusReports.push(await readJson(req))
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/apply-requirement`) {
      await readJson(req)
      if (applyCount++ >= maxApplications) {
        return sendJson(res, 200, { requirement: null, task: null, executionSlice: null, tasks: [], repositories: [] })
      }
      tasks[0]!.status = 'in_progress'
      executionSlice.status = 'in_progress'
      return sendJson(res, 200, {
        requirement: requirementPayload(),
        task: tasks[0],
        executionSlice: slicePayload(),
        tasks,
        leaseGeneration: 1,
        runId: '00000000-0000-4000-8000-0000000000f1',
        repositories: [{ link: delivery, repository }, { link: secondaryDelivery, repository: secondaryRepository }],
      })
    }

    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/progress`) {
      const body = await readJson(req)
      progressReports.push(body)
      return sendJson(res, 200, { id: randomUUID(), ...body })
    }

    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/reconcile`) {
      const body = await readJson(req)
      reconcileReports.push(body)
      const quarantined = body.workspaceState === 'conflicted' || body.workspaceState === 'missing'
      for (const task of tasks) {
        if (task.status === 'in_progress') task.status = quarantined ? 'in_review' : 'todo'
      }
      executionSlice.status = quarantined ? 'in_review' : 'todo'
      executionSlice.resultSummary = body.sliceSummary ?? body.reason
      return sendJson(res, 200, {
        recoveredTaskIds: tasks.filter((task) => task.status === (quarantined ? 'in_review' : 'todo')).map((task) => task.id),
        recoveryDisposition: quarantined ? 'quarantine' : 'retry',
      })
    }

    if (req.method === 'GET' && path === '/api/v1/context/bootstrap') {
      return sendJson(res, 200, { description: 'Test bootstrap', usage: 'test', commands: [] })
    }

    if (req.method === 'GET' && path === `/api/v1/requirements/${requirementId}`) {
      return sendJson(res, 200, requirementPayload())
    }

    const taskStatusMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/status$/)
    if (req.method === 'PATCH' && taskStatusMatch) {
      const body = await readJson(req)
      const task = tasks.find((item) => item.id === taskStatusMatch[1])
      if (!task) return sendJson(res, 404, { error: 'Task not found' })
      task.status = body.status
      task.updatedAt = new Date().toISOString()
      return sendJson(res, 200, task)
    }

    if (req.method === 'PATCH' && path === `/api/v1/execution-slices/${executionSliceId}`) {
      Object.assign(executionSlice, await readJson(req))
      return sendJson(res, 200, slicePayload())
    }

    if (req.method === 'PATCH' && path === `/api/v1/requirements/${requirementId}`) {
      Object.assign(requirement, await readJson(req))
      return sendJson(res, 200, requirementPayload())
    }

    const deliveryMatch = path.match(/^\/api\/v1\/requirement-repositories\/([^/]+)\/delivery$/)
    if (req.method === 'PATCH' && deliveryMatch) {
      const target = [delivery, secondaryDelivery].find((item) => item.id === deliveryMatch[1])
      if (!target) return sendJson(res, 404, { error: 'Delivery not found' })
      const body = await readJson(req)
      if (body.operationCheckpoint) {
        const checkpoint = body.operationCheckpoint
        target.operationCheckpoints = {
          ...target.operationCheckpoints,
          [checkpoint.operation]: {
            ...checkpoint,
            attempt: target.retryCount,
            updatedAt: new Date().toISOString(),
          },
        }
      }
      Object.assign(target, body)
      return sendJson(res, 200, target)
    }

    const commentMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/comments$/)
    if (req.method === 'POST' && commentMatch) {
      const body = await readJson(req)
      comments.push({ taskId: commentMatch[1]!, content: String(body.content ?? '') })
      return sendJson(res, 201, { id: randomUUID(), taskId: commentMatch[1], content: body.content })
    }

    if (req.method === 'POST' && path === `/api/v1/requirements/${requirementId}/release`) {
      releaseCount += 1
      await readJson(req)
      return sendJson(res, 200, { released: true })
    }

    sendJson(res, 404, { error: `Unhandled ${req.method} ${path}` })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const apiUrl = `http://127.0.0.1:${address.port}`
    const spawnDaemon = () => spawn(
      process.execPath,
      [
        '--import', 'tsx/esm', join(process.cwd(), 'src/index.ts'),
        'daemon', 'start', '--tools', 'fake-agent', '--project', projectId,
        '--workers', String(workers), '--mode', 'polling', '--id', daemonId, '--once',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          TW_API_URL: apiUrl,
          TW_API_KEY: 'test-key',
          TW_CLIENT_ID: 'daemon-e2e-client',
          TW_NODE_ID: 'daemon-e2e-node',
          GIT_AUTHOR_NAME: 'Task Weaver Test',
          GIT_AUTHOR_EMAIL: 'task-weaver@example.test',
          GIT_COMMITTER_NAME: 'Task Weaver Test',
          GIT_COMMITTER_EMAIL: 'task-weaver@example.test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const child = spawnDaemon()
    const exit = waitForExit(child, 45_000)
    if (mode === 'slow') {
      await waitForOutput(child, /fake-agent-ready/, 20_000)
      child.kill('SIGINT')
    }
    let result = await exit
    let firstCycleDeliveryStatus: string | undefined
    let firstCycleSecondaryStatus: string | undefined
    let secondaryCommitAfterFirstCycle: string | undefined
    let secondaryCommitAfterRetry: string | undefined
    if (mode === 'partial-retry') {
      firstCycleDeliveryStatus = delivery.deliveryStatus
      firstCycleSecondaryStatus = secondaryDelivery.deliveryStatus
      secondaryCommitAfterFirstCycle = runGit(['--git-dir', secondaryRemote, 'rev-parse', branchName]).stdout
      const primaryBase = join(home, '.task-weaver', 'repository-checkouts', 'daemon-e2e-node', repositoryId, 'base')
      runGit(['remote', 'set-url', 'origin', pathToFileURL(remote).href], primaryBase)
      Object.assign(delivery, {
        deliveryStatus: 'pending',
        failureCode: null,
        failureSummary: null,
        pushStatus: 'pending',
        retryRole: 'executor',
        resumeOperation: 'push',
      })
      requirement.status = 'in_progress'
      executionSlice.status = 'todo'
      tasks[0]!.status = 'todo'
      const retryChild = spawnDaemon()
      result = await waitForExit(retryChild, 45_000)
      secondaryCommitAfterRetry = runGit(['--git-dir', secondaryRemote, 'rev-parse', branchName]).stdout
    }
    const revParse = runGit(['--git-dir', remote, 'rev-parse', '--verify', branchName], undefined, true)
    const branchPushed = revParse.status === 0
    const branchFileResult = runGit(['--git-dir', remote, 'show', `${branchName}:daemon-output.txt`], undefined, true)
    const secondaryRevParse = runGit(['--git-dir', secondaryRemote, 'rev-parse', '--verify', branchName], undefined, true)
    const secondaryBranchFileResult = runGit(['--git-dir', secondaryRemote, 'show', `${branchName}:daemon-output.txt`], undefined, true)

    return {
      applyCount,
      releaseCount,
      requirement,
      executionSlice,
      tasks,
      comments,
      statusReports,
      progressReports,
      reconcileReports,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      branchPushed,
      branchFile: branchFileResult.status === 0 ? branchFileResult.stdout : null,
      delivery,
      secondaryBranchPushed: secondaryRevParse.status === 0,
      secondaryBranchFile: secondaryBranchFileResult.status === 0 ? secondaryBranchFileResult.stdout : null,
      secondaryDelivery,
      firstCycleDeliveryStatus,
      firstCycleSecondaryStatus,
      secondaryCommitAfterFirstCycle,
      secondaryCommitAfterRetry,
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    await rm(root, { recursive: true, force: false })
  }
}

test('daemon --once runs a fake-agent requirement lane and publishes both repository branches', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('happy')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.applyCount, 1)
  assert.equal(result.releaseCount, 1)
  assert.equal(result.requirement.status, 'in_review')
  assert.equal(result.executionSlice.status, 'done')
  assert.equal(result.tasks.every((task) => task.status === 'done'), true)
  assert.ok(result.statusReports.some((report) => report.status === 'busy'))
  assert.ok(result.statusReports.some((report) => report.status === 'idle'))
  assert.match(result.comments[0]?.content ?? '', /Repository delivery finished/)
  assert.equal(result.delivery.deliveryStatus, 'pushed')
  assert.equal(result.branchPushed, true)
  assert.equal(result.branchFile, 'happy fake-agent completed the daemon path')
  assert.equal(result.secondaryDelivery.deliveryStatus, 'pushed')
  assert.equal(result.secondaryBranchPushed, true)
  assert.equal(result.secondaryBranchFile, 'happy fake-agent completed the daemon path')
})

test('daemon --once acquires one lane total when configured with multiple workers', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('happy', 3)

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.applyCount, 1)
  assert.equal(result.releaseCount, 1)
  assert.equal(result.tasks.every((task) => task.status === 'done'), true)
})

test('daemon --once finalizes no-change clean runs with an auditable comment', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('no-change')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.requirement.status, 'in_review')
  assert.equal(result.executionSlice.status, 'done')
  assert.equal(result.tasks.every((task) => task.status === 'done'), true)
  assert.equal(result.branchPushed, false)
  assert.equal(result.branchFile, null)
  assert.equal(result.delivery.deliveryStatus, 'unchanged')
  assert.equal(result.secondaryBranchPushed, false)
  assert.equal(result.secondaryBranchFile, null)
  assert.equal(result.secondaryDelivery.deliveryStatus, 'unchanged')
  assert.match(result.comments[0]?.content ?? '', /Repository delivery finished/)
})

test('daemon --once preserves one successful repository when another push fails', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('push-failure')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.requirement.status, 'in_review')
  assert.equal(result.executionSlice.status, 'done')
  assert.equal(result.tasks.every((task) => task.status === 'done'), true)
  assert.equal(result.branchPushed, false)
  assert.equal(result.delivery.deliveryStatus, 'failed')
  assert.equal(result.delivery.failureCode, 'git_push_failed')
  assert.equal(result.secondaryBranchPushed, true)
  assert.equal(result.secondaryBranchFile, 'push-failure fake-agent completed the daemon path')
  assert.equal(result.secondaryDelivery.deliveryStatus, 'pushed')
})

test('daemon follow-up retries only the failed repository and preserves its successful sibling', { timeout: 90_000 }, async () => {
  const result = await runDaemonScenario('partial-retry')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.applyCount, 2)
  assert.equal(result.releaseCount, 2)
  assert.equal(result.firstCycleDeliveryStatus, 'failed')
  assert.equal(result.firstCycleSecondaryStatus, 'pushed')
  assert.equal(result.delivery.deliveryStatus, 'pushed')
  assert.equal(result.secondaryDelivery.deliveryStatus, 'pushed')
  assert.equal(result.branchPushed, true)
  assert.equal(result.secondaryCommitAfterRetry, result.secondaryCommitAfterFirstCycle)
  assert.equal(result.delivery.operationCheckpoints.push.status, 'completed')
  assert.equal(result.secondaryDelivery.operationCheckpoints.push.status, 'completed')
})

test('daemon --once reverts active task and slice after fake tool non-zero exit', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('non-zero')

  assert.equal(result.exitCode, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.releaseCount, 1)
  assert.equal(result.requirement.status, 'approved')
  assert.equal(result.executionSlice.status, 'todo')
  assert.equal(result.tasks[0]!.status, 'todo')
  assert.equal(result.reconcileReports.length, 1)
  assert.equal(result.reconcileReports[0]?.runId, '00000000-0000-4000-8000-0000000000f1')
  assert.ok(result.progressReports.some((report) => report.phase === 'executing'))
  assert.equal(result.tasks[1]!.status, 'todo')
  assert.equal(result.branchPushed, false)
  assert.equal(result.secondaryBranchPushed, false)
})

test('daemon --once routes clean exits without task finalization to review', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('no-finalize')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.releaseCount, 1)
  assert.equal(result.requirement.status, 'approved')
  assert.equal(result.executionSlice.status, 'in_review')
  assert.equal(result.tasks[0]!.status, 'in_review')
  assert.equal(result.tasks[1]!.status, 'todo')
  assert.equal(result.branchPushed, false)
  assert.equal(result.secondaryBranchPushed, false)
})

test('daemon SIGINT drains a running child and leaves durable retry state', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('slow')

  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(result.releaseCount, 1)
  assert.equal(result.requirement.status, 'approved')
  assert.equal(result.executionSlice.status, 'todo')
  assert.equal(result.tasks[0]!.status, 'todo')
  assert.equal(result.reconcileReports.length, 1)
  assert.equal(result.tasks[1]!.status, 'todo')
  assert.ok(result.statusReports.some((report) =>
    report.activeWorkerStates?.some((worker: any) => worker.status === 'stopping'),
  ))
  assert.ok(result.statusReports.some((report) => report.status === 'offline'))
  assert.match(result.comments.map((comment) => comment.content).join('\n'), /cancelled.*returned to todo/i)
  assert.match(result.stdout, /entering drain mode/)
})


test('daemon stops before acquisition when bounded delegation is unavailable', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('delegation-unavailable')
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /delegation is not available/)
  assert.equal(result.applyCount, 0)
  assert.equal(result.progressReports.length, 0)
  assert.equal(result.branchPushed, false)
})

test('human keys never become managed-agent daemon identities', { timeout: 60_000 }, async () => {
  const result = await runDaemonScenario('human-key')
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /verified managed-agent identity/)
  assert.equal(result.applyCount, 0)
  assert.equal(result.progressReports.length, 0)
  assert.equal(result.branchPushed, false)
})
