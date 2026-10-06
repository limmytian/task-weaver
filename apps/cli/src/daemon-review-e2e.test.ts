import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

function runGit(args: string[], cwd?: string, allowFailure = false): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (!allowFailure) {
    assert.equal(result.status, 0, `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
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

async function createBareReviewRepository(
  root: string,
  name: string,
  branchFile: string,
  branchContent: string,
): Promise<{ remote: string; seed: string }> {
  const seed = join(root, `${name}-seed`)
  const remote = join(root, `${name}-remote.git`)
  await mkdir(seed, { recursive: true })

  runGit(['init'], seed)
  runGit(['checkout', '-b', 'main'], seed)
  runGit(['config', 'user.name', 'Task Weaver Test'], seed)
  runGit(['config', 'user.email', 'task-weaver@example.test'], seed)
  await writeFile(join(seed, 'README.md'), `# ${name} Review E2E\n`, 'utf8')
  await writeFile(join(seed, 'shared.txt'), 'base\n', 'utf8')
  runGit(['add', 'README.md', 'shared.txt'], seed)
  runGit(['commit', '-m', 'seed'], seed)
  runGit(['checkout', '-b', 'req/review-e2e'], seed)
  await writeFile(join(seed, branchFile), `${branchContent}\n`, 'utf8')
  runGit(['add', branchFile], seed)
  runGit(['commit', '-m', 'feat: review branch'], seed)
  runGit(['checkout', 'main'], seed)
  runGit(['init', '--bare', remote])
  runGit(['remote', 'add', 'origin', remote], seed)
  runGit(['push', '-u', 'origin', 'main'], seed)
  runGit(['push', '-u', 'origin', 'req/review-e2e'], seed)
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  return { remote, seed }
}

async function createReviewGitFixture(root: string): Promise<{
  home: string
  remote: string
  secondaryRemote: string
  secondarySeed: string
}> {
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const primary = await createBareReviewRepository(
    root,
    'primary',
    'review-output.txt',
    'review daemon merged this branch',
  )
  const secondary = await createBareReviewRepository(
    root,
    'secondary',
    'shared.txt',
    'working branch change',
  )
  await writeFile(
    join(home, '.gitconfig'),
    '[credential]\n\thelper = store\n[user]\n\tname = Task Weaver Test\n\temail = task-weaver@example.test\n',
    'utf8',
  )

  return {
    home,
    remote: primary.remote,
    secondaryRemote: secondary.remote,
    secondarySeed: secondary.seed,
  }
}

test('daemon review and merge preserve partial success through a multi-repository conflict and rework cycle', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-review-daemon-'))
  const { home, remote, secondaryRemote, secondarySeed } = await createReviewGitFixture(root)
  const projectId = '00000000-0000-4000-8000-0000000000f2'
  const daemonId = '00000000-0000-4000-8000-0000000000db'
  const requirementId = '00000000-0000-4000-8000-00000000d0e2'
  const taskId = '00000000-0000-4000-8000-00000000d0a2'
  const branchName = 'req/review-e2e'
  const task = {
    id: taskId,
    projectId,
    requirementId,
    title: 'Review task',
    description: 'Review task',
    status: 'done',
    priority: 'high',
    tags: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  }
  const requirement = {
    id: requirementId,
    projectId,
    title: 'Review daemon E2E',
    description: 'Merge this branch',
    status: 'in_review',
    priority: 'high',
    modelTier: 'strong',
    branchName,
    tasks: [task] as Array<Record<string, any>>,
  }
  const repositoryId = '00000000-0000-4000-8000-0000000000e2'
  const delivery: Record<string, any> = {
    id: '00000000-0000-4000-8000-0000000000d2',
    requirementId,
    repositoryId,
    baseBranch: 'main',
    workingBranch: branchName,
    deliveryStatus: 'in_review',
    manifestVersion: 1,
    retryCount: 0,
  }
  const repository = {
    id: repositoryId,
    displayName: 'Review E2E Repository',
    canonicalKey: 'local.test/task-weaver/review-e2e',
    provider: 'generic',
    host: 'local.test',
    namespace: 'task-weaver',
    name: 'review-e2e',
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
  const secondaryDelivery: Record<string, any> = {
    ...delivery,
    id: '00000000-0000-4000-8000-0000000000d3',
    repositoryId: '00000000-0000-4000-8000-0000000000e3',
  }
  const secondaryRepository = {
    ...repository,
    id: secondaryDelivery.repositoryId,
    displayName: 'Secondary Review E2E Repository',
    canonicalKey: 'secondary.local/task-weaver/review-e2e',
    host: 'secondary.local',
    name: 'review-e2e-secondary',
    httpsCloneUrl: pathToFileURL(secondaryRemote).href,
  }
  const deliveryUpdates: string[] = []
  const comments: string[] = []
  const reviewRuns: Array<Record<string, unknown>> = []
  const followupTasks: Array<Record<string, any>> = []
  let releaseCount = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/api/v1/auth/me') return sendJson(res, 200, { actor: { id: '00000000-0000-4000-8000-0000000000aa', type: 'agent' }, account: null, session: null })

    if (req.method === 'POST' && path === '/api/v1/daemons/register') {
      await readJson(req)
      return sendJson(res, 201, { id: daemonId, status: 'idle', config: { executionDelegationSupported: true, mode: 'polling', pollingIntervalMs: 20, pollingBackoffMax: 50 } })
    }
    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/status`) {
      await readJson(req)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/heartbeat`) {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/apply-review`) {
      const body = await readJson(req)
      assert.equal(body.projectId, projectId)
      if (requirement.status !== 'in_review') {
        return sendJson(res, 200, { requirement: null, tasks: [], executionSlice: null, repositories: [] })
      }
      return sendJson(res, 200, {
        requirement,
        tasks: requirement.tasks,
        executionSlice: null,
        leaseGeneration: 1,
        repositories: [
          { link: delivery, repository },
          { link: secondaryDelivery, repository: secondaryRepository },
        ],
      })
    }
    if (req.method === 'POST' && path === `/api/v1/daemons/${daemonId}/apply-merge`) {
      const body = await readJson(req)
      assert.equal(body.projectId, projectId)
      if (requirement.status !== 'ready_to_merge') {
        return sendJson(res, 200, { requirement: null, tasks: [], executionSlice: null, repositories: [] })
      }
      return sendJson(res, 200, {
        requirement,
        tasks: requirement.tasks,
        executionSlice: null,
        leaseGeneration: 1,
        repositories: [
          { link: delivery, repository },
          { link: secondaryDelivery, repository: secondaryRepository },
        ],
      })
    }
    if (req.method === 'POST' && path === `/api/v1/requirements/${requirementId}/heartbeat`) {
      await readJson(req)
      return sendJson(res, 200, { id: randomUUID(), requirementId, claimedBy: daemonId })
    }
    if (req.method === 'GET' && path === `/api/v1/requirements/${requirementId}`) {
      return sendJson(res, 200, requirement)
    }
    if (req.method === 'GET' && path === `/api/v1/requirements/${requirementId}/review-policy`) {
      return sendJson(res, 200, {
        source: 'built_in',
        requiredChecks: [],
        requireAiReview: false,
        minimumHumanApprovals: 0,
        requireIndependentReviewer: false,
        requireIndependentMerger: false,
        allowedMergeModes: ['provider', 'direct', 'manual'],
        defaultMergeMode: 'direct',
        baseBranch: 'main',
        retryPolicy: { maxAttempts: 3, initialBackoffSeconds: 30, maxBackoffSeconds: 900 },
        allowManualOverride: false,
        overrideRequiresReason: true,
      })
    }
    if (req.method === 'POST' && path === `/api/v1/requirements/${requirementId}/review-runs`) {
      const body = await readJson(req)
      const run = { id: randomUUID(), status: 'running', ...body }
      reviewRuns.push(run)
      return sendJson(res, 201, run)
    }
    const reviewRunMatch = path.match(/^\/api\/v1\/review-runs\/([^/]+)\/(checks|findings|decisions|evaluate)$/)
    if (reviewRunMatch) {
      const run = reviewRuns.find((candidate) => candidate.id === reviewRunMatch[1])
      if (!run) return sendJson(res, 404, { error: 'Review run not found' })
      const body = await readJson(req)
      if (req.method === 'POST' && reviewRunMatch[2] === 'evaluate') {
        run.status = 'approved'
        return sendJson(res, 200, {
          run,
          evaluation: { satisfied: true, evidence: [], blockers: [], overridden: false },
        })
      }
      return sendJson(res, req.method === 'POST' ? 201 : 200, { id: randomUUID(), ...body })
    }
    if (req.method === 'PATCH' && path === `/api/v1/requirements/${requirementId}`) {
      Object.assign(requirement, await readJson(req))
      return sendJson(res, 200, requirement)
    }
    const deliveryMatch = path.match(/^\/api\/v1\/requirement-repositories\/([^/]+)\/delivery$/)
    if (req.method === 'PATCH' && deliveryMatch) {
      const target = [delivery, secondaryDelivery].find((candidate) => candidate.id === deliveryMatch[1])
      if (!target) return sendJson(res, 404, { error: 'Delivery not found' })
      deliveryUpdates.push(target.id)
      Object.assign(target, await readJson(req))
      return sendJson(res, 200, target)
    }
    if (req.method === 'POST' && path === `/api/v1/tasks/${taskId}/comments`) {
      const body = await readJson(req)
      comments.push(String(body.content ?? ''))
      return sendJson(res, 201, { id: randomUUID(), taskId, content: body.content })
    }
    if (req.method === 'POST' && path === `/api/v1/projects/${projectId}/tasks`) {
      const body = await readJson(req)
      const followup = {
        id: randomUUID(),
        projectId,
        requirementId,
        status: body.status ?? 'todo',
        ...body,
      }
      followupTasks.push(followup)
      requirement.tasks.push(followup)
      return sendJson(res, 201, followup)
    }
    if (req.method === 'POST' && path === `/api/v1/requirements/${requirementId}/release`) {
      releaseCount += 1
      await readJson(req)
      return sendJson(res, 200, { released: true })
    }

    return sendJson(res, 404, { error: `Unhandled ${req.method} ${path}` })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const apiUrl = `http://127.0.0.1:${address.port}`
    const reviewChild = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        join(process.cwd(), 'src/index.ts'),
        'daemon',
        'review',
        '--project',
        projectId,
        '--id',
        daemonId,
        '--skip-ai-review',
        '--allow-unreviewed',
        '--once',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          TW_API_URL: apiUrl,
          TW_API_KEY: 'test-key',
          TW_CLIENT_ID: 'review-daemon-e2e-client',
          TW_NODE_ID: 'review-daemon-e2e-node',
          GIT_AUTHOR_NAME: 'Task Weaver Test',
          GIT_AUTHOR_EMAIL: 'task-weaver@example.test',
          GIT_COMMITTER_NAME: 'Task Weaver Test',
          GIT_COMMITTER_EMAIL: 'task-weaver@example.test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const reviewResult = await waitForExit(reviewChild, 45_000)
    const beforeMerge = runGit(['--git-dir', remote, 'show', 'main:review-output.txt'], undefined, true)

    assert.equal(reviewResult.code, 0, `stdout:\n${reviewResult.stdout}\nstderr:\n${reviewResult.stderr}`)
    assert.notEqual(beforeMerge.status, 0)
    assert.equal(requirement.status, 'ready_to_merge')

    await writeFile(join(secondarySeed, 'shared.txt'), 'base advanced after review\n', 'utf8')
    runGit(['add', 'shared.txt'], secondarySeed)
    runGit(['commit', '-m', 'test: advance secondary base'], secondarySeed)
    runGit(['push', 'origin', 'main'], secondarySeed)

    const spawnMerger = () => spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        join(process.cwd(), 'src/index.ts'),
        'daemon',
        'merge',
        '--project',
        projectId,
        '--id',
        daemonId,
        '--once',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          TW_API_URL: apiUrl,
          TW_API_KEY: 'test-key',
          TW_CLIENT_ID: 'merge-daemon-e2e-client',
          TW_NODE_ID: 'merge-daemon-e2e-node',
          GIT_AUTHOR_NAME: 'Task Weaver Test',
          GIT_AUTHOR_EMAIL: 'task-weaver@example.test',
          GIT_COMMITTER_NAME: 'Task Weaver Test',
          GIT_COMMITTER_EMAIL: 'task-weaver@example.test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const mergeResult = await waitForExit(spawnMerger(), 45_000)
    const branchFile = runGit(['--git-dir', remote, 'show', 'main:review-output.txt'])
    const primaryMergedCommit = runGit(['--git-dir', remote, 'rev-parse', 'main']).stdout

    assert.equal(mergeResult.code, 0, `stdout:\n${mergeResult.stdout}\nstderr:\n${mergeResult.stderr}`)
    assert.equal(branchFile.stdout, 'review daemon merged this branch')
    assert.equal(delivery.deliveryStatus, 'merged')
    assert.equal(secondaryDelivery.deliveryStatus, 'failed')
    assert.equal(secondaryDelivery.failureCode, 'merge_conflict')
    assert.equal(requirement.status, 'in_progress')
    assert.equal(followupTasks.length, 1)

    runGit(['checkout', 'req/review-e2e'], secondarySeed)
    runGit(['merge', 'main'], secondarySeed, true)
    await writeFile(join(secondarySeed, 'shared.txt'), 'resolved branch and advanced base\n', 'utf8')
    runGit(['add', 'shared.txt'], secondarySeed)
    runGit(['commit', '-m', 'fix: resolve secondary base conflict'], secondarySeed)
    runGit(['push', 'origin', branchName], secondarySeed)
    Object.assign(secondaryDelivery, {
      deliveryStatus: 'ready_to_merge',
      reviewStatus: 'approved',
      mergeStatus: 'ready',
      failureCode: null,
      failureSummary: null,
    })
    followupTasks[0]!.status = 'done'
    requirement.status = 'ready_to_merge'

    const retryResult = await waitForExit(spawnMerger(), 45_000)
    const secondaryFile = runGit(['--git-dir', secondaryRemote, 'show', 'main:shared.txt'])

    assert.equal(retryResult.code, 0, `stdout:\n${retryResult.stdout}\nstderr:\n${retryResult.stderr}`)
    assert.equal(secondaryFile.stdout, 'resolved branch and advanced base')
    assert.equal(runGit(['--git-dir', remote, 'rev-parse', 'main']).stdout, primaryMergedCommit)
    assert.equal(secondaryDelivery.deliveryStatus, 'merged')
    assert.equal(requirement.status, 'done')
    assert.equal(releaseCount, 3)
    assert.equal(reviewRuns.length, 2)
    assert.equal(reviewRuns.every((run) => run.status === 'approved'), true)
    assert.equal(deliveryUpdates.includes(secondaryDelivery.id), true)
    assert.equal(comments.filter((comment) => /Daemon review summary/.test(comment)).length, 2)
    assert.ok(comments.some((comment) => /Daemon merge summary/.test(comment)))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    await rm(root, { recursive: true, force: true })
  }
})
