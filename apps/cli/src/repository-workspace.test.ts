import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { Config } from './config.js'
import {
  inspectCompositeWorkspace,
  isRepositoryRelevantToPhase,
  normalizeRequirementRepositoryEntries,
  provisionCompositeWorkspace,
  withRepositoryWorkspaceLock,
  type RequirementRepositoryEntry,
} from './repository-workspace.js'

test('repository entries normalize Drizzle relation rows at the daemon API boundary', () => {
  const repository = {
    id: 'repository-1',
    canonicalKey: 'git.example.test/team/repository',
  }
  const [normalized] = normalizeRequirementRepositoryEntries([{
    id: 'link-1',
    requirementId: 'requirement-1',
    repositoryId: 'repository-1',
    deliveryStatus: 'pending',
    repository,
  }])

  assert.equal(normalized?.link.id, 'link-1')
  assert.equal(normalized?.link.deliveryStatus, 'pending')
  assert.equal(normalized?.repository, repository)
})

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function createRemote(root: string, name: string) {
  const seed = join(root, `${name}-seed`)
  const remote = join(root, `${name}.git`)
  await mkdir(seed, { recursive: true })
  git(['init'], seed)
  git(['checkout', '-b', 'main'], seed)
  git(['config', 'user.name', 'Task Weaver Test'], seed)
  git(['config', 'user.email', 'task-weaver@example.test'], seed)
  await writeFile(join(seed, 'README.md'), `# ${name}\n`, 'utf8')
  git(['add', 'README.md'], seed)
  git(['commit', '-m', 'seed'], seed)
  git(['init', '--bare', remote])
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'main'], seed)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  return pathToFileURL(remote).href
}

function entry(options: {
  linkId: string
  requirementId: string
  repositoryId: string
  name: string
  canonicalKey: string
  remote: string
  workingBranch: string
  deliveryStatus?: string
}): RequirementRepositoryEntry {
  return {
    link: {
      id: options.linkId,
      requirementId: options.requirementId,
      repositoryId: options.repositoryId,
      baseBranch: 'main',
      workingBranch: options.workingBranch,
      deliveryStatus: options.deliveryStatus ?? 'pending',
      manifestVersion: null,
      retryCount: 0,
    },
    repository: {
      id: options.repositoryId,
      displayName: options.name,
      canonicalKey: options.canonicalKey,
      provider: 'generic',
      host: 'local.test',
      namespace: 'task-weaver',
      name: options.name,
      defaultBranch: 'main',
      sshCloneUrl: null,
      httpsCloneUrl: options.remote,
      authPolicy: {
        allowedTransports: ['https'],
        preferredTransport: 'https',
        allowedOperations: ['read', 'push'],
        allowNativeDefault: true,
      },
    },
  }
}

test('composite workspaces preserve slice state, accept added repositories, and isolate concurrent requirements', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-workspace-'))
  const home = join(root, 'home')
  const previousHome = process.env.HOME
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = store\n[user]\n\tname = Task Weaver Test\n\temail = task-weaver@example.test\n', 'utf8')
  await chmod(join(home, '.gitconfig'), 0o600)
  process.env.HOME = home

  try {
    const primaryRemote = await createRemote(root, 'primary')
    const addedRemote = await createRemote(root, 'added')
    const config: Config = { apiUrl: 'http://task-weaver.test', nodeId: 'node-e2e' }
    const primary = entry({
      linkId: 'link-primary', requirementId: 'requirement-a', repositoryId: 'repository-primary',
      name: 'primary', canonicalKey: 'local.test/task-weaver/primary', remote: primaryRemote,
      workingBranch: 'req/requirement-a',
    })
    const added = entry({
      linkId: 'link-added', requirementId: 'requirement-a', repositoryId: 'repository-added',
      name: 'added', canonicalKey: 'local.test/task-weaver/added', remote: addedRemote,
      workingBranch: 'req/requirement-a',
    })
    const deliveryUpdates: Array<{ linkId: string; fields: Record<string, unknown> }> = []
    const updateDelivery = async (linkId: string, fields: Record<string, unknown>) => {
      deliveryUpdates.push({ linkId, fields })
      return fields
    }

    const first = await provisionCompositeWorkspace({
      config,
      requirement: { id: 'requirement-a', title: 'Requirement A', branchName: 'req/requirement-a' },
      executionSlice: { id: 'slice-one', orderIndex: 0 },
      entries: [primary],
      updateDelivery,
    })
    const firstPrimary = first.repositories[0]!
    assert.deepEqual(await inspectCompositeWorkspace(first, { config, entries: [primary] }), {
      workspaceState: 'clean',
      pendingDiffSummary: null,
    })
    await writeFile(join(firstPrimary.worktreePath, 'slice-state.txt'), 'preserved between slices\n', 'utf8')
    const dirtySnapshot = await inspectCompositeWorkspace(first, { config, entries: [primary] })
    assert.equal(dirtySnapshot.workspaceState, 'dirty')
    assert.match(dirtySnapshot.pendingDiffSummary ?? '', /slice-state\.txt/)

    const second = await provisionCompositeWorkspace({
      config,
      requirement: { id: 'requirement-a', title: 'Requirement A', branchName: 'req/requirement-a' },
      executionSlice: { id: 'slice-two', orderIndex: 1 },
      entries: [primary, added],
      updateDelivery,
    })
    const secondPrimary = second.repositories.find((repository) => repository.repositoryId === primary.repository.id)!
    assert.equal(second.repositories.length, 2)
    assert.equal(existsSync(firstPrimary.worktreePath), false)
    assert.equal(await readFile(join(secondPrimary.worktreePath, 'slice-state.txt'), 'utf8'), 'preserved between slices\n')
    assert.equal(second.manifestVersion, 2)
    assert.equal((await stat(second.manifestPath)).mode & 0o777, 0o600)
    const manifest = await readFile(second.manifestPath, 'utf8')
    assert.doesNotMatch(manifest, /cloneUrl|credential|secret|token/i)

    const concurrent = entry({
      linkId: 'link-concurrent', requirementId: 'requirement-b', repositoryId: primary.repository.id,
      name: 'primary', canonicalKey: primary.repository.canonicalKey, remote: primaryRemote,
      workingBranch: 'req/requirement-b',
    })
    const third = await provisionCompositeWorkspace({
      config,
      requirement: { id: 'requirement-b', title: 'Requirement B', branchName: 'req/requirement-b' },
      executionSlice: { id: 'slice-concurrent', orderIndex: 0 },
      entries: [concurrent],
      updateDelivery,
    })
    assert.notEqual(third.repositories[0]!.worktreePath, secondPrimary.worktreePath)
    assert.equal(existsSync(third.repositories[0]!.worktreePath), true)
    assert.equal(existsSync(secondPrimary.worktreePath), true)
    assert.ok(deliveryUpdates.some((update) => update.linkId === 'link-added' && update.fields.deliveryStatus === 'ready'))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('composite workspaces exclude terminal repository deliveries until explicitly reopened', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-terminal-'))
  const home = join(root, 'home')
  const previousHome = process.env.HOME
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = store\n[user]\n\tname = Task Weaver Test\n\temail = task-weaver@example.test\n', 'utf8')
  await chmod(join(home, '.gitconfig'), 0o600)
  process.env.HOME = home

  try {
    const activeRemote = await createRemote(root, 'active')
    const mergedRemote = await createRemote(root, 'merged')
    const unchangedRemote = await createRemote(root, 'unchanged')
    const config: Config = { apiUrl: 'http://task-weaver.test', nodeId: 'node-terminal' }
    const active = entry({
      linkId: 'link-active', requirementId: 'requirement-terminal', repositoryId: 'repository-active',
      name: 'active', canonicalKey: 'local.test/task-weaver/active', remote: activeRemote,
      workingBranch: 'req/requirement-terminal',
    })
    const merged = entry({
      linkId: 'link-merged', requirementId: 'requirement-terminal', repositoryId: 'repository-merged',
      name: 'merged', canonicalKey: 'local.test/task-weaver/merged', remote: mergedRemote,
      workingBranch: 'req/requirement-terminal', deliveryStatus: 'merged',
    })
    const unchanged = entry({
      linkId: 'link-unchanged', requirementId: 'requirement-terminal', repositoryId: 'repository-unchanged',
      name: 'unchanged', canonicalKey: 'local.test/task-weaver/unchanged', remote: unchangedRemote,
      workingBranch: 'req/requirement-terminal', deliveryStatus: 'unchanged',
    })
    const deliveryUpdates: Array<{ linkId: string; fields: Record<string, unknown> }> = []
    const workspace = await provisionCompositeWorkspace({
      config,
      requirement: { id: 'requirement-terminal', title: 'Terminal repositories' },
      executionSlice: { id: 'slice-rework', orderIndex: 1 },
      entries: [merged, active, unchanged],
      updateDelivery: async (linkId, fields) => {
        deliveryUpdates.push({ linkId, fields })
        return fields
      },
    })

    assert.deepEqual(workspace.repositories.map((repository) => repository.linkId), ['link-active'])
    assert.equal(deliveryUpdates.some((update) => update.linkId === 'link-merged'), false)
    assert.equal(deliveryUpdates.some((update) => update.linkId === 'link-unchanged'), false)
    const manifest = await readFile(workspace.manifestPath, 'utf8')
    assert.doesNotMatch(manifest, /repository-merged|repository-unchanged/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('repository phase filtering targets only the role that owns the next operation', () => {
  const base = {
    linkId: 'link-phase', requirementId: 'requirement-phase', repositoryId: 'repository-phase',
    name: 'phase', canonicalKey: 'local.test/task-weaver/phase', remote: 'file:///tmp/phase.git',
    workingBranch: 'req/phase',
  }
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'ready' }), 'execution'), true)
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'in_review' }), 'execution'), false)
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'in_review' }), 'review'), true)
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'ready_to_merge' }), 'review'), false)
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'ready_to_merge' }), 'merge'), true)
  assert.equal(isRepositoryRelevantToPhase(entry({ ...base, deliveryStatus: 'merged' }), 'merge'), false)
})

test('multi-cycle partial-success routing retries only failed push, review, and merge siblings', () => {
  const make = (suffix: string) => entry({
    linkId: `link-${suffix}`, requirementId: 'requirement-cycles', repositoryId: `repository-${suffix}`,
    name: suffix, canonicalKey: `local.test/task-weaver/${suffix}`, remote: `file:///tmp/${suffix}.git`,
    workingBranch: 'req/cycles',
  })
  const failed = make('failed')
  const successful = make('successful')
  const successfulCommit = 'successful-commit'

  failed.link.deliveryStatus = 'failed'
  failed.link.retryRole = 'executor'
  failed.link.resumeOperation = 'push'
  successful.link.deliveryStatus = 'pushed'
  successful.link.operationCheckpoints = {
    push: { status: 'completed', attempt: 0, updatedAt: new Date().toISOString(), commit: successfulCommit },
  }
  assert.deepEqual(
    [failed, successful].filter((candidate) => isRepositoryRelevantToPhase(candidate, 'execution'))
      .map((candidate) => candidate.link.id),
    [failed.link.id],
  )

  failed.link.deliveryStatus = 'failed'
  failed.link.retryRole = 'reviewer'
  failed.link.resumeOperation = 'review'
  successful.link.deliveryStatus = 'ready_to_merge'
  assert.deepEqual(
    [failed, successful].filter((candidate) => isRepositoryRelevantToPhase(candidate, 'review'))
      .map((candidate) => candidate.link.id),
    [failed.link.id],
  )

  failed.link.deliveryStatus = 'failed'
  failed.link.retryRole = 'merger'
  failed.link.resumeOperation = 'merge'
  successful.link.deliveryStatus = 'merged'
  assert.deepEqual(
    [failed, successful].filter((candidate) => isRepositoryRelevantToPhase(candidate, 'merge'))
      .map((candidate) => candidate.link.id),
    [failed.link.id],
  )
  assert.equal(successful.link.operationCheckpoints.push?.commit, successfulCommit)
  assert.equal(successful.link.operationCheckpoints.push?.status, 'completed')
})

test('repository workspace locks serialize processes and expose one owner at a time', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-lock-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  const config: Config = { apiUrl: 'http://task-weaver.test', nodeId: 'node-lock' }
  const repository = entry({
    linkId: 'link-lock', requirementId: 'requirement-lock', repositoryId: 'repository-lock',
    name: 'lock', canonicalKey: 'local.test/task-weaver/lock', remote: 'file:///tmp/lock.git',
    workingBranch: 'req/lock',
  }).repository
  const events: string[] = []

  try {
    const first = withRepositoryWorkspaceLock({ config, repository, operation: 'first' }, async () => {
      events.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 100))
      events.push('first:end')
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = withRepositoryWorkspaceLock({ config, repository, operation: 'second' }, async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.all([first, second])
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('repository workspace locks recover stale owners and report live owner diagnostics', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-stale-lock-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  const config: Config = { apiUrl: 'http://task-weaver.test', nodeId: 'node-stale-lock' }
  const repository = entry({
    linkId: 'link-stale-lock', requirementId: 'requirement-lock', repositoryId: 'repository-stale-lock',
    name: 'stale-lock', canonicalKey: 'local.test/task-weaver/stale-lock', remote: 'file:///tmp/stale-lock.git',
    workingBranch: 'req/stale-lock',
  }).repository
  const lockPath = join(root, '.task-weaver', 'repository-locks', 'node-stale-lock', 'repository-stale-lock.lock')

  try {
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'stale-owner',
      pid: 2_147_483_647,
      operation: 'abandoned-fetch',
      repositoryId: repository.id,
      acquiredAt: new Date().toISOString(),
    }), 'utf8')
    let recovered = false
    await withRepositoryWorkspaceLock({ config, repository, operation: 'recovered' }, async () => {
      recovered = true
    })
    assert.equal(recovered, true)

    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      operation: 'active-fetch',
      repositoryId: repository.id,
      acquiredAt: new Date().toISOString(),
    }), 'utf8')
    await assert.rejects(
      () => withRepositoryWorkspaceLock({
        config, repository, operation: 'contender', timeoutMs: 20,
      }, async () => undefined),
      /active-fetch/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
