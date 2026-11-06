import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { deliverThinGitRepository } from './thin-git-orchestrator.js'
import { prepareThinPushSandbox } from './thin-git-delivery.js'
import { applyThinDeliveries, captureThinPatches, packageThinArtifacts } from './thin-workspace-artifacts.js'
import type { Config } from './config.js'
import {
  inspectCompositeWorkspace,
  isRepositoryRelevantToPhase,
  normalizeRequirementRepositoryEntries,
  provisionCompositeWorkspace,
  provisionThinWorkspace,
  fetchThinIntegrationTarget,
  createThinPushRunner,
  verifyThinWorkspaceBaselines,
  withRepositoryWorkspaceLock,
  type RequirementRepositoryEntry,
} from './repository-workspace.js'

// Fixture repositories use file URLs and must never consult host credential helpers.
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.GIT_ASKPASS = '/usr/bin/false'

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

test('thin workspaces isolate parallel attempts and preserve dirty work', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-thin-workspace-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = store --file /dev/null\n')
  process.env.HOME = home
  try {
    const remote = await createRemote(root, 'thin')
    const projectId = '00000000-0000-4000-8000-000000000001'
    const requirementId = '00000000-0000-4000-8000-000000000002'
    const taskIds = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004']
    const attemptIds = ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006']
    const repository = entry({ linkId: 'link', requirementId, repositoryId: '00000000-0000-4000-8000-000000000007', name: 'thin', canonicalKey: 'local.test/task-weaver/thin', remote, workingBranch: 'main' })
    const options = (index: number) => ({ config: { apiUrl: 'http://task-weaver.test', nodeId: 'node-thin' }, projectId, requirementId, taskId: taskIds[index]!, attemptId: attemptIds[index]!, planRevision: 2, entries: [repository], assertAuthority: async () => {} })
    const [first, second] = await Promise.all([provisionThinWorkspace(options(0)), provisionThinWorkspace(options(1))])
    assert.notEqual(first.rootPath, second.rootPath)
    assert.notEqual(first.repositories[0]!.workingBranch, second.repositories[0]!.workingBranch)
    assert.equal(first.repositories[0]!.headCommit, second.repositories[0]!.headCommit)
    await writeFile(join(first.repositories[0]!.worktreePath, 'README.md'), 'dirty first\n')
    const binary = Buffer.from([0, 1, 2, 255, 128, 10])
    await writeFile(join(first.repositories[0]!.worktreePath, 'binary.dat'), binary)
    assert.notEqual(await readFile(join(second.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    await assert.rejects(provisionThinWorkspace(options(0)))
    assert.equal(await readFile(join(first.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    const retry = await provisionThinWorkspace({ ...options(0), attemptId: '00000000-0000-4000-8000-000000000008' })
    assert.notEqual(retry.rootPath, first.rootPath)
    assert.notEqual(retry.repositories[0]!.workingBranch, first.repositories[0]!.workingBranch)
    assert.equal(await readFile(join(first.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    const reportPath = join(retry.rootPath, 'result.md')
    await writeFile(reportPath, 'Plan and evidence\n')
    const noPatches = await captureThinPatches(retry, async () => {})
    const reportPackage = await packageThinArtifacts(retry, noPatches, async () => {}, reportPath)
    assert.equal(JSON.parse(await readFile(reportPackage, 'utf8')).report, 'Plan and evidence')
    const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8'))
    assert.equal(manifest.attemptId, attemptIds[0])
    assert.equal(manifest.repositories[0].baseCommit, first.repositories[0]!.headCommit)
    const patches = await captureThinPatches(first, async () => {})
    assert.equal(patches.length, 1)
    assert.match(await readFile(patches[0]!.path, 'utf8'), /dirty first/)
    assert.equal(patches[0]!.baseCommit, first.repositories[0]!.headCommit)
    const packagePath = await packageThinArtifacts(first, patches, async () => {})
    const delivery = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(delivery.manifest.attemptId, attemptIds[0])
    assert.match(Buffer.from(delivery.repositories[0].patch, 'base64').toString('utf8'), /dirty first/)
    await assert.rejects(packageThinArtifacts(first, [{ ...patches[0]!, baseCommit: 'a'.repeat(40) }], async () => {}), /outside/)
    await writeFile(join(second.repositories[0]!.worktreePath, 'other.txt'), 'independent\n')
    const secondPatches = await captureThinPatches(second, async () => {})
    const secondPackage = await packageThinArtifacts(second, secondPatches, async () => {})
    const baselineOptions = { config: options(0).config, workspace: first, entries: [repository], assertAuthority: async () => {} }
    await verifyThinWorkspaceBaselines(baselineOptions)
    const integrationBaseline = { ...baselineOptions, workspace: retry }
    const integrated = await applyThinDeliveries({ workspace: retry, projectId, requirementId, taskId: taskIds[0]!, attemptId: '00000000-0000-4000-8000-000000000008', planRevision: 2, packages: [packagePath, secondPackage], assertAuthority: async () => {}, assertBaseline: () => verifyThinWorkspaceBaselines(integrationBaseline) })
    assert.equal(integrated[0]!.sourceAttemptId, attemptIds[0])
    assert.equal(integrated[1]!.sourceAttemptId, attemptIds[1])
    assert.equal(await readFile(join(retry.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    assert.deepEqual(await readFile(join(retry.repositories[0]!.worktreePath, 'binary.dat')), binary)
    assert.equal(await readFile(join(retry.repositories[0]!.worktreePath, 'other.txt'), 'utf8'), 'independent\n')
    assert.equal(await readFile(join(first.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    const conflictAttempt = '00000000-0000-4000-8000-000000000009'
    const conflictWorkspace = await provisionThinWorkspace({ ...options(1), attemptId: conflictAttempt })
    await assert.rejects(applyThinDeliveries({ workspace: conflictWorkspace, projectId, requirementId, taskId: taskIds[1]!, attemptId: conflictAttempt, planRevision: 2, packages: [packagePath, packagePath], assertAuthority: async () => {}, assertBaseline: () => verifyThinWorkspaceBaselines({ ...baselineOptions, workspace: conflictWorkspace }) }), /conflicts/)
    assert.equal(await readFile(join(conflictWorkspace.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    await writeFile(join(root, 'thin-seed', 'new-base.txt'), 'advanced\n')
    git(['add', 'new-base.txt'], join(root, 'thin-seed'))
    git(['commit', '-m', 'advance baseline'], join(root, 'thin-seed'))
    git(['push', 'origin', 'main'], join(root, 'thin-seed'))
    await assert.rejects(verifyThinWorkspaceBaselines(baselineOptions), /baseline changed/)
    const target = await fetchThinIntegrationTarget({ ...baselineOptions, repositoryId: repository.repository.id })
    assert.equal(target, git(['rev-parse', 'HEAD'], join(root, 'thin-seed')))
    assert.notEqual(target, first.repositories[0]!.headCommit)
    const sandbox = await prepareThinPushSandbox({ source: first.repositories[0]!.worktreePath, commit: first.repositories[0]!.headCommit!, assertAuthority: async () => {} })
    try {
      const runner = createThinPushRunner({ config: options(0).config, entry: repository, gitDir: sandbox.gitDir })
      assert.equal(runner.remote, remote)
      const observed = await runner.git(['ls-remote', '--exit-code', runner.remote, 'refs/heads/main'])
      assert.equal(observed.ok, true)
      assert.equal(observed.stdout.trim(), `${target}\trefs/heads/main`)
    } finally { await sandbox.cleanup() }
    await assert.rejects(fetchThinIntegrationTarget({ ...baselineOptions, entries: [{ ...repository, link: { ...repository.link, workingBranch: null } }], repositoryId: repository.repository.id }), /configured requirement branch/)
    const calls: string[] = []
    let allowPush = true
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        calls.push(req.url ?? '')
        res.setHeader('content-type', 'application/json')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.end(JSON.stringify(req.url?.endsWith('/prepare') ? { id: attemptIds[0] } : req.url?.endsWith('/transition') ? { shouldPush: body.event === 'start_push' && allowPush } : { state: 'confirmed' }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
      const deliveryAttempt = '00000000-0000-4000-8000-000000000010'
      const deliveryWorkspace = await provisionThinWorkspace({ ...options(0), attemptId: deliveryAttempt })
      await writeFile(join(deliveryWorkspace.repositories[0]!.worktreePath, 'delivery.txt'), 'task delivery\n')
      const delivered = await deliverThinGitRepository({ config: { ...options(0).config, apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' }, workspace: deliveryWorkspace, entries: [repository], repositoryId: repository.repository.id, fence: { attemptId: deliveryAttempt, workerId: attemptIds[0]!, token: 'fixture' }, identity: { name: 'Fixture', email: 'fixture@example.test' }, message: 'Deliver fixture', assertAuthority: async () => {}, resolveConflict: async () => { throw new Error('Unexpected conflict') } })
      assert.equal(delivered.state, 'confirmed')
      assert.equal(git(['rev-parse', 'refs/heads/main'], join(root, 'thin.git')), delivered.commit)
      assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['prepare', 'transition', 'confirm'])
      allowPush = false
      const deniedAttempt = '00000000-0000-4000-8000-000000000011'
      const deniedWorkspace = await provisionThinWorkspace({ ...options(0), attemptId: deniedAttempt })
      await writeFile(join(deniedWorkspace.repositories[0]!.worktreePath, 'denied.txt'), 'must not push\n')
      await assert.rejects(deliverThinGitRepository({ config: { ...options(0).config, apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' }, workspace: deniedWorkspace, entries: [repository], repositoryId: repository.repository.id, fence: { attemptId: deniedAttempt, workerId: attemptIds[0]!, token: 'fixture' }, identity: { name: 'Fixture', email: 'fixture@example.test' }, message: 'Denied fixture', assertAuthority: async () => {}, resolveConflict: async () => {} }), /not newly granted/)
      assert.equal(git(['rev-parse', 'refs/heads/main'], join(root, 'thin.git')), delivered.commit)
      assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['prepare', 'transition', 'confirm', 'prepare', 'transition'])

    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }

    assert.equal(await readFile(join(first.repositories[0]!.worktreePath, 'README.md'), 'utf8'), 'dirty first\n')
    git(['config', 'user.name', 'Task Weaver Test'], second.repositories[0]!.worktreePath)
    git(['config', 'user.email', 'test@example.test'], second.repositories[0]!.worktreePath)
    await writeFile(join(second.repositories[0]!.worktreePath, 'later.txt'), 'new base\n')
    git(['add', 'later.txt'], second.repositories[0]!.worktreePath)
    git(['commit', '-m', 'unexpected commit'], second.repositories[0]!.worktreePath)
    await rm(join(second.rootPath, 'artifacts'), { recursive: true })
    await assert.rejects(captureThinPatches(second, async () => {}), /HEAD changed/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

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

test('controlled Git requires agent-led synchronization of existing worktrees and preserves stale dirty work', { timeout: 60000 }, async () => {
  const { createControlledGit } = await import('./controlled-git.js')
  const root = await mkdtemp(join(tmpdir(), 'tw-controlled-git-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = store\n[user]\n\tname = Task Weaver Test\n\temail = task-weaver@example.test\n', 'utf8')
  await chmod(join(home, '.gitconfig'), 0o600)
  process.env.HOME = home
  try {
    const remote = await createRemote(root, 'sync')
    const seed = join(root, 'sync-seed')
    const repository = entry({ linkId: 'sync-link', requirementId: 'sync-requirement', repositoryId: 'sync-repo', name: 'sync', canonicalKey: 'local.test/task-weaver/sync', remote, workingBranch: 'req/sync' })
    repository.link.operationCheckpoints = { fetch: { status: 'completed', attempt: 1, updatedAt: new Date().toISOString() } }
    repository.link.resumeOperation = 'push'
    const config: Config = { apiUrl: 'http://task-weaver.test', nodeId: 'node-a' }
    const workspace = await provisionCompositeWorkspace({ config, requirement: { id: 'sync-requirement', title: 'Sync' }, entries: [repository], updateDelivery: async () => {} })
    const path = workspace.repositories[0]!.worktreePath
    git(['config', 'user.name', 'Task Weaver Test'], path)
    git(['config', 'user.email', 'task-weaver@example.test'], path)
    let authorityChecks = 0
    const records: unknown[] = []
    const controlled = createControlledGit({ config, workspace, entries: [repository], assertAuthority: async () => { authorityChecks++ }, record: async input => { records.push(input) } })
    await controlled({ operation: 'verify', repositoryId: 'sync-repo' })
    assert.equal(records.length, 1)
    git(['checkout', '-b', 'req/sync'], seed)
    await writeFile(join(seed, 'remote.txt'), 'new result from node B\n')
    git(['add', '.'], seed); git(['commit', '-m', 'advance target on node B'], seed); git(['push', 'origin', 'req/sync'], seed)
    const latest = git(['rev-parse', 'HEAD'], seed)
    const oldHead = git(['rev-parse', 'HEAD'], path)
    const fetched = await controlled({ operation: 'fetch', repositoryId: 'sync-repo' })
    assert.equal(fetched.remoteTip, latest)
    assert.equal(git(['rev-parse', 'HEAD'], path), oldHead, 'fetch does not advance an existing worktree')
    await assert.rejects(controlled({ operation: 'verify', repositoryId: 'sync-repo' }), /not in working history/)
    await writeFile(join(path, 'preserved.txt'), 'untracked obsolete-run candidate\n')
    git(['merge', '--ff-only', latest], path)
    await controlled({ operation: 'verify', repositoryId: 'sync-repo' })
    assert.equal(await readFile(join(path, 'preserved.txt'), 'utf8'), 'untracked obsolete-run candidate\n')
    await writeFile(join(path, 'local.txt'), 'legitimate local commit\n')
    git(['add', 'local.txt'], path); git(['commit', '-m', 'local work'], path)
    const localHead = git(['rev-parse', 'HEAD'], path)
    await writeFile(join(seed, 'second.txt'), 'second remote result\n')
    git(['add', '.'], seed); git(['commit', '-m', 'advance again'], seed); git(['push', 'origin', 'req/sync'], seed)
    await assert.rejects(controlled({ operation: 'verify', repositoryId: 'sync-repo' }), /not in working history/)
    assert.equal(git(['rev-parse', 'HEAD'], path), localHead, 'divergence must not reset or automatically merge old work')
    git(['merge', '--no-edit', 'origin/req/sync'], path)
    const verified = await controlled({ operation: 'verify', repositoryId: 'sync-repo' })
    assert.equal(verified.includesRemoteTip, true)
    assert.notEqual(verified.localHead, verified.remoteTip, 'valid local commits do not require HEAD equality')
    git(['push', '--force', 'origin', `${oldHead}:refs/heads/req/sync`], seed)
    await assert.rejects(controlled({ operation: 'verify', repositoryId: 'sync-repo' }), /rewritten or deleted/)
    await assert.rejects(controlled({ operation: 'verify', repositoryId: 'sync-repo' }), /rewritten or deleted/, 'repeated fetch must not silently clear rewrite provenance')
    assert.ok(authorityChecks >= 10)
    const revoked = createControlledGit({ config, workspace, entries: [repository], assertAuthority: async () => { throw new Error('revoked execution') }, record: async () => assert.fail('revoked run recorded sync') })
    await assert.rejects(revoked({ operation: 'fetch', repositoryId: 'sync-repo' }), /revoked execution/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
