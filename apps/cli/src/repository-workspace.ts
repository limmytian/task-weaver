import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { Config } from './config.js'
import {
  getGitProviderAdapter,
  runTrustedGitCommand,
  type RepositoryDeliveryResult,
} from './git-provider.js'
import { throwIfCancelled } from './daemon-lifecycle.js'
import { runCommand } from './async-command.js'
import {
  redactTrustedOutput,
  resolveRepositoryCredential,
  type CredentialRepository,
  type RepositoryAuthPolicy,
} from './repository-credentials.js'

export interface RequirementRepositoryLink {
  id: string
  requirementId: string
  repositoryId: string
  baseBranch: string | null
  workingBranch: string | null
  deliveryStatus: string
  manifestVersion: number | null
  retryCount: number
  headCommit?: string | null
  pushedCommit?: string | null
  pullRequestProvider?: string | null
  pullRequestExternalId?: string | null
  pullRequestUrl?: string | null
  reviewStatus?: string
  mergeStatus?: string
  mergeMode?: 'provider' | 'direct' | 'manual' | null
  manualActionUrl?: string | null
  externalState?: Record<string, unknown>
  externalStateUpdatedAt?: string | null
  externalSyncRevision?: number
  retryRole?: 'executor' | 'reviewer' | 'merger' | null
  resumeOperation?: string | null
  operationCheckpoints?: Record<string, {
    status: 'in_progress' | 'completed' | 'failed' | 'skipped'
    attempt: number
    updatedAt: string
    commit?: string
    summary?: string
  }> | null
}

export interface WorkspaceRepository extends CredentialRepository {
  displayName: string
  canonicalKey: string
  namespace: string
  name: string
  defaultBranch: string | null
  webUrl?: string | null
  authPolicy?: RepositoryAuthPolicy | null
}

export interface RequirementRepositoryEntry {
  link: RequirementRepositoryLink
  repository: WorkspaceRepository
}

export function normalizeRequirementRepositoryEntries(entries: unknown[]): RequirementRepositoryEntry[] {
  return entries.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('Requirement repository entry must be an object')
    }
    const entry = value as Record<string, unknown>
    if (entry.link && entry.repository) return entry as unknown as RequirementRepositoryEntry
    if (!entry.repository) throw new Error('Requirement repository entry is missing repository metadata')
    const { repository, ...link } = entry
    return {
      link: link as unknown as RequirementRepositoryLink,
      repository: repository as WorkspaceRepository,
    }
  })
}

export interface ProvisionedRepository {
  linkId: string
  repositoryId: string
  displayName: string
  canonicalKey: string
  provider: string
  relativePath: string
  basePath: string
  worktreePath: string
  baseBranch: string
  workingBranch: string
  headCommit: string | null
}

export interface CompositeWorkspace {
  rootPath: string
  manifestPath: string
  manifestVersion: number
  repositories: ProvisionedRepository[]
}

export interface WorkspaceRecoverySnapshot {
  workspaceState: 'unknown' | 'clean' | 'dirty' | 'conflicted' | 'missing'
  pendingDiffSummary: string | null
}

export type UpdateDelivery = (linkId: string, fields: Record<string, unknown>) => Promise<unknown>
export type RepositoryDeliveryPhase = 'execution' | 'review' | 'merge'

export function isTerminalRepositoryEntry(entry: RequirementRepositoryEntry) {
  return entry.link.deliveryStatus === 'merged' || entry.link.deliveryStatus === 'unchanged'
}

export function isRepositoryRelevantToPhase(
  entry: RequirementRepositoryEntry,
  phase: RepositoryDeliveryPhase,
) {
  if (isTerminalRepositoryEntry(entry)) return false
  if (entry.link.deliveryStatus === 'failed') {
    return !entry.link.retryRole || entry.link.retryRole === ({
      execution: 'executor',
      review: 'reviewer',
      merge: 'merger',
    } as const)[phase]
  }
  const statuses: Record<RepositoryDeliveryPhase, readonly string[]> = {
    execution: ['pending', 'provisioning', 'ready', 'changed', 'pushing'],
    review: ['pushed', 'in_review'],
    merge: ['ready_to_merge'],
  }
  return statuses[phase].includes(entry.link.deliveryStatus)
}

interface RepositoryLockOwner {
  token: string
  pid: number
  operation: string
  repositoryId: string
  acquiredAt: string
}

function repositoryLockPath(config: Config, repository: WorkspaceRepository) {
  return join(
    homedir(),
    '.task-weaver',
    'repository-locks',
    safeSegment(config.nodeId ?? 'local-node'),
    `${repository.id}.lock`,
  )
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Repository lock wait cancelled'))
    }, { once: true })
  })
}

export async function withRepositoryWorkspaceLock<T>(options: {
  config: Config
  repository: WorkspaceRepository
  operation: string
  signal?: AbortSignal
  timeoutMs?: number
  staleAfterMs?: number
}, action: () => Promise<T>): Promise<T> {
  const lockPath = repositoryLockPath(options.config, options.repository)
  const ownerPath = join(lockPath, 'owner.json')
  const timeoutMs = options.timeoutMs ?? 30_000
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000
  const startedAt = Date.now()
  const owner: RepositoryLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    operation: options.operation,
    repositoryId: options.repository.id,
    acquiredAt: new Date().toISOString(),
  }
  await mkdir(join(lockPath, '..'), { recursive: true })

  while (true) {
    if (options.signal) throwIfCancelled(options.signal)
    try {
      await mkdir(lockPath)
      await writeFile(ownerPath, JSON.stringify(owner, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let currentOwner: RepositoryLockOwner | null = null
      try {
        currentOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as RepositoryLockOwner
      } catch {
        currentOwner = null
      }
      const acquiredAt = currentOwner ? Date.parse(currentOwner.acquiredAt) : Number.NaN
      const stale = currentOwner !== null
        && ((!processIsAlive(currentOwner.pid)) || (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > staleAfterMs))
      if (stale) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for repository lock ${lockPath}; owner=${JSON.stringify(currentOwner)}`)
      }
      await delay(100, options.signal)
    }
  }

  try {
    return await action()
  } finally {
    try {
      const currentOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as RepositoryLockOwner
      if (currentOwner.token === owner.token) await rm(lockPath, { recursive: true, force: true })
    } catch {
      // A stale-lock recovery may already have removed this owner's lock.
    }
  }
}

function cancellableAdapter(provider: string, signal?: AbortSignal) {
  return getGitProviderAdapter(
    provider,
    signal
      ? (command, args, cwd, environment) => runTrustedGitCommand(command, args, cwd, environment, signal)
      : undefined,
  )
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repository'
}

function baseCheckoutPath(config: Config, repository: WorkspaceRepository) {
  return join(
    homedir(),
    '.task-weaver',
    'repository-checkouts',
    safeSegment(config.nodeId ?? 'local-node'),
    repository.id,
    'base',
  )
}

function compositeRoot(requirementId: string, sliceId?: string | null) {
  return join(
    homedir(),
    '.task-weaver',
    'requirement-workspaces',
    requirementId,
    sliceId ? `slice-${safeSegment(sliceId)}` : 'unplanned-slice',
  )
}

function remoteFor(repository: WorkspaceRepository, transport: 'ssh' | 'https') {
  return transport === 'ssh' ? repository.sshCloneUrl : repository.httpsCloneUrl
}

export async function inspectCompositeWorkspace(
  workspace: CompositeWorkspace,
  options: {
    config?: Config
    entries?: RequirementRepositoryEntry[]
    signal?: AbortSignal
  } = {},
): Promise<WorkspaceRecoverySnapshot> {
  const signal = options.signal
  const entriesByLinkId = new Map((options.entries ?? []).map((entry) => [entry.link.id, entry]))
  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
  const results = await Promise.all(workspace.repositories.map(async (repository) => {
    if (signal) throwIfCancelled(signal)
    if (!existsSync(repository.worktreePath)) {
      return {
        state: 'missing' as const,
        summary: `${repository.canonicalKey}: worktree is missing`,
      }
    }
    const entry = entriesByLinkId.get(repository.linkId)
    const credential = options.config && entry
      ? resolveRepositoryCredential(options.config, entry.repository, 'read')
      : null
    const gitArgs = credential?.state === 'available'
      ? [...(credential.trustedGitConfig ?? []), '--no-pager', 'status', '--porcelain=v1', '--untracked-files=all']
      : ['--no-pager', 'status', '--porcelain=v1', '--untracked-files=all']
    const status = await runCommand(
      'git',
      gitArgs,
      {
        cwd: repository.worktreePath,
        env: credential?.state === 'available' && credential.trustedEnvironment
          ? credential.trustedEnvironment
          : process.env,
        timeoutMs: 1_000,
        killGraceMs: 500,
        maxOutputBytes: 256 * 1024,
        signal,
        redact: redactTrustedOutput,
      },
    )
    if (!status.ok) {
      return {
        state: 'unknown' as const,
        summary: `${repository.canonicalKey}: git status failed (${status.status ?? 'unknown'})`,
      }
    }
    const lines = status.stdout.split(/\r?\n/).filter(Boolean)
    if (lines.some((line) => conflictCodes.has(line.slice(0, 2)))) {
      return {
        state: 'conflicted' as const,
        summary: `${repository.canonicalKey}:\n${lines.join('\n')}`,
      }
    }
    if (lines.length > 0) {
      return {
        state: 'dirty' as const,
        summary: `${repository.canonicalKey}:\n${lines.join('\n')}`,
      }
    }
    return { state: 'clean' as const, summary: null }
  }))

  const precedence: WorkspaceRecoverySnapshot['workspaceState'][] = [
    'conflicted',
    'missing',
    'unknown',
    'dirty',
    'clean',
  ]
  const workspaceState = precedence.find((candidate) =>
    results.some((result) => result.state === candidate),
  ) ?? 'clean'
  const summaries = results
    .map((result) => result.summary)
    .filter((summary): summary is string => summary !== null)
  const pendingDiffSummary = summaries.length > 0
    ? summaries.join('\n\n').slice(0, 10_000)
    : null
  return { workspaceState, pendingDiffSummary }
}

async function configureSecretFreeWorktree(adapter: ReturnType<typeof getGitProviderAdapter>, credential: ReturnType<typeof resolveRepositoryCredential>, path: string) {
  const commands = [
    ['config', '--local', '--replace-all', 'credential.helper', ''],
    ['config', '--local', '--replace-all', 'core.hooksPath', '/dev/null'],
    ['config', '--local', '--replace-all', 'core.sshCommand', '/usr/bin/false'],
  ]
  for (const args of commands) {
    const result = await adapter.git(credential, args, path)
    if (!result.ok) throw new Error(`worktree_security_config_failed: ${result.stderr || result.stdout}`)
  }
}

async function existingOrigin(adapter: ReturnType<typeof getGitProviderAdapter>, credential: ReturnType<typeof resolveRepositoryCredential>, path: string) {
  const result = await adapter.git(credential, ['remote', 'get-url', 'origin'], path)
  return result.ok ? result.stdout.trim() : null
}

async function existingBranchWorktree(
  adapter: ReturnType<typeof getGitProviderAdapter>,
  credential: ReturnType<typeof resolveRepositoryCredential>,
  basePath: string,
  branchName: string,
) {
  const result = await adapter.git(credential, ['worktree', 'list', '--porcelain'], basePath)
  if (!result.ok) return null
  for (const block of result.stdout.split(/\n(?=worktree )/)) {
    const lines = block.split('\n')
    const pathLine = lines.find((line) => line.startsWith('worktree '))
    const branchLine = lines.find((line) => line === `branch refs/heads/${branchName}`)
    if (pathLine && branchLine) return pathLine.slice('worktree '.length).trim()
  }
  return null
}

export async function provisionCompositeWorkspace(options: {
  config: Config
  requirement: { id: string; title: string; branchName?: string | null }
  executionSlice?: { id: string; orderIndex?: number } | null
  entries: RequirementRepositoryEntry[]
  updateDelivery: UpdateDelivery
  preserveDeliveryStatus?: boolean
  deliveryPhase?: RepositoryDeliveryPhase
  signal?: AbortSignal
}): Promise<CompositeWorkspace> {
  const { config, requirement, executionSlice, updateDelivery } = options
  const deliveryPhase = options.deliveryPhase ?? 'execution'
  const entries = options.entries
    .filter((entry) => isRepositoryRelevantToPhase(entry, deliveryPhase))
    .sort((a, b) => a.repository.canonicalKey.localeCompare(b.repository.canonicalKey))
  const manifestVersion = (executionSlice?.orderIndex ?? 0) + 1
  const rootPath = compositeRoot(requirement.id, executionSlice?.id)
  mkdirSync(rootPath, { recursive: true })
  const provisioned: ProvisionedRepository[] = []

  for (const entry of entries) {
    if (options.signal) throwIfCancelled(options.signal)
    const { link, repository } = entry
    await withRepositoryWorkspaceLock({
      config,
      repository,
      operation: `${deliveryPhase}-workspace`,
      signal: options.signal,
    }, async () => {
    const preserveDeliveryStatus = options.preserveDeliveryStatus || link.deliveryStatus !== 'pending'
    const checkpoint = (
      operation: 'clone' | 'fetch',
      status: 'in_progress' | 'completed' | 'failed' | 'skipped',
      summary?: string,
    ) => updateDelivery(link.id, {
      operationCheckpoint: { operation, status, ...(summary ? { summary } : {}) },
    })
    const operationOrder = ['clone', 'fetch', 'commit', 'push', 'pull_request', 'review', 'merge']
    const canSkipCompletedOperation = (operation: 'clone' | 'fetch') => {
      const checkpointStatus = link.operationCheckpoints?.[operation]?.status
      if (checkpointStatus !== 'completed' && checkpointStatus !== 'skipped') return false
      const resumeIndex = link.resumeOperation ? operationOrder.indexOf(link.resumeOperation) : -1
      return resumeIndex > operationOrder.indexOf(operation)
    }
    await updateDelivery(link.id, {
      ...(!preserveDeliveryStatus ? { deliveryStatus: 'provisioning' } : {}),
      manifestVersion,
      lastAttemptAt: new Date().toISOString(),
      failureCode: null,
      failureSummary: null,
    })
    const credential = resolveRepositoryCredential(config, repository, 'read')
    if (credential.state !== 'available') {
      await updateDelivery(link.id, {
        deliveryStatus: 'failed',
        failureCode: credential.reasonCode,
        failureSummary: `Repository provisioning is unavailable: ${credential.reasonCode}`,
      })
      throw new Error(`Repository ${repository.canonicalKey} is not ready: ${credential.reasonCode}`)
    }
    const adapter = cancellableAdapter(repository.provider, options.signal)
    const remote = remoteFor(repository, credential.transport)
    if (!remote) throw new Error(`Repository ${repository.canonicalKey} has no ${credential.transport} clone endpoint`)
    const basePath = baseCheckoutPath(config, repository)
    mkdirSync(join(basePath, '..'), { recursive: true })
    if (!existsSync(basePath)) {
      await checkpoint('clone', 'in_progress')
      const clone = await adapter.git(credential, ['clone', '--no-checkout', '--', remote, basePath], rootPath)
      if (!clone.ok) {
        await updateDelivery(link.id, {
          deliveryStatus: 'failed', failureCode: 'git_clone_failed',
          failureSummary: `Repository clone failed: ${clone.stderr || clone.stdout}`,
          operationCheckpoint: {
            operation: 'clone', status: 'failed', summary: clone.stderr || clone.stdout || 'Clone failed',
          },
        })
        throw new Error(`Repository clone failed for ${repository.canonicalKey}`)
      }
      await checkpoint('clone', 'completed')
    } else {
      const origin = await existingOrigin(adapter, credential, basePath)
      if (origin !== remote) {
        await updateDelivery(link.id, {
          deliveryStatus: 'failed', failureCode: 'remote_identity_mismatch',
          failureSummary: 'Existing base checkout remote does not match the frozen repository endpoint.',
        })
        throw new Error(`Repository remote identity mismatch for ${repository.canonicalKey}`)
      }
      if (!canSkipCompletedOperation('clone')) await checkpoint('clone', 'skipped', 'Existing checkout verified')
    }
    if (!canSkipCompletedOperation('fetch')) {
      await checkpoint('fetch', 'in_progress')
      const fetch = await adapter.git(credential, ['fetch', '--prune', 'origin'], basePath)
      if (!fetch.ok) {
        await updateDelivery(link.id, {
          deliveryStatus: 'failed', failureCode: 'git_fetch_failed',
          failureSummary: `Repository fetch failed: ${fetch.stderr || fetch.stdout}`,
          operationCheckpoint: {
            operation: 'fetch', status: 'failed', summary: fetch.stderr || fetch.stdout || 'Fetch failed',
          },
        })
        throw new Error(`Repository fetch failed for ${repository.canonicalKey}`)
      }
      await checkpoint('fetch', 'completed')
    }

    const baseBranch = link.baseBranch ?? repository.defaultBranch ?? 'main'
    const workingBranch = link.workingBranch
      ?? requirement.branchName
      ?? `req/${requirement.id.slice(0, 8)}-${repository.id.slice(0, 8)}`
    const relativePath = `${safeSegment(repository.name)}-${repository.id.slice(0, 8)}`
    const worktreePath = join(rootPath, relativePath)
    if (!existsSync(worktreePath)) {
      const priorWorktree = await existingBranchWorktree(adapter, credential, basePath, workingBranch)
      if (priorWorktree) {
        const move = await adapter.git(credential, ['worktree', 'move', priorWorktree, worktreePath], basePath)
        if (!move.ok) {
          await updateDelivery(link.id, {
            deliveryStatus: 'failed', failureCode: 'git_worktree_move_failed',
            failureSummary: `Repository worktree rollover failed: ${move.stderr || move.stdout}`,
          })
          throw new Error(`Repository worktree rollover failed for ${repository.canonicalKey}`)
        }
      } else {
        const remoteBranch = await adapter.git(credential, ['rev-parse', '--verify', '--quiet', `origin/${workingBranch}`], basePath)
        const startRef = remoteBranch.ok ? `origin/${workingBranch}` : `origin/${baseBranch}`
        const add = await adapter.git(credential, ['worktree', 'add', '-B', workingBranch, worktreePath, startRef], basePath)
        if (!add.ok) {
          await updateDelivery(link.id, {
            deliveryStatus: 'failed', failureCode: 'git_worktree_failed',
            failureSummary: `Repository worktree provisioning failed: ${add.stderr || add.stdout}`,
          })
          throw new Error(`Repository worktree failed for ${repository.canonicalKey}`)
        }
      }
    }
    await configureSecretFreeWorktree(adapter, credential, worktreePath)
    const head = await adapter.git(credential, ['rev-parse', 'HEAD'], worktreePath)
    const workspaceKey = `${config.nodeId ?? 'local-node'}:${requirement.id}:${repository.id}`
    await updateDelivery(link.id, {
      workspaceKey,
      manifestVersion,
      provisionedAt: new Date().toISOString(),
      headCommit: head.ok ? head.stdout.trim() : null,
      deliveryStatus: preserveDeliveryStatus ? link.deliveryStatus : 'ready',
    })
    provisioned.push({
      linkId: link.id,
      repositoryId: repository.id,
      displayName: repository.displayName,
      canonicalKey: repository.canonicalKey,
      provider: repository.provider,
      relativePath,
      basePath,
      worktreePath,
      baseBranch,
      workingBranch,
      headCommit: head.ok ? head.stdout.trim() : null,
    })
    })
  }

  const manifestPath = join(rootPath, 'repository-manifest.json')
  writeFileSync(manifestPath, JSON.stringify({
    version: manifestVersion,
    requirementId: requirement.id,
    executionSliceId: executionSlice?.id ?? null,
    frozenAt: new Date().toISOString(),
    repositories: provisioned.map((repository) => ({
      repositoryId: repository.repositoryId,
      canonicalKey: repository.canonicalKey,
      displayName: repository.displayName,
      provider: repository.provider,
      relativePath: repository.relativePath,
      baseBranch: repository.baseBranch,
      workingBranch: repository.workingBranch,
      headCommit: repository.headCommit,
    })),
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return { rootPath, manifestPath, manifestVersion, repositories: provisioned }
}

export async function finalizeCompositeWorkspace(options: {
  config: Config
  workspace: CompositeWorkspace
  entries: RequirementRepositoryEntry[]
  requirement: { title: string }
  updateDelivery: UpdateDelivery
  signal?: AbortSignal
}): Promise<Array<{ linkId: string; result: RepositoryDeliveryResult }>> {
  const entryByLink = new Map(options.entries.map((entry) => [entry.link.id, entry]))
  const results: Array<{ linkId: string; result: RepositoryDeliveryResult }> = []
  for (const provisioned of options.workspace.repositories) {
    if (options.signal) throwIfCancelled(options.signal)
    const entry = entryByLink.get(provisioned.linkId)
    if (!entry) continue
    const credential = resolveRepositoryCredential(options.config, entry.repository, 'push')
    const adapter = cancellableAdapter(entry.repository.provider, options.signal)
    const forgeCredential = adapter.capabilities.pullRequest
      ? resolveRepositoryCredential(options.config, entry.repository, 'forge')
      : undefined
    const checkpointStatus = (operation: string) => entry.link.operationCheckpoints?.[operation]?.status
    const checkpointCompleted = (operation: string) => {
      const status = checkpointStatus(operation)
      return status === 'completed' || status === 'skipped'
    }
    await options.updateDelivery(provisioned.linkId, {
      deliveryStatus: 'pushing',
      pushStatus: checkpointCompleted('push') ? 'pushed' : 'pushing',
      lastAttemptAt: new Date().toISOString(),
      operationCheckpoint: { operation: 'commit', status: 'in_progress' },
    })
    const result = await adapter.finalize({
      worktreePath: provisioned.worktreePath,
      branchName: provisioned.workingBranch,
      baseBranch: provisioned.baseBranch,
      title: options.requirement.title,
      body: `Automated delivery for ${options.requirement.title}.`,
      credential,
      forgeCredential,
      skipPush: checkpointCompleted('push'),
      repository: {
        host: entry.repository.host,
        namespace: entry.repository.namespace,
        name: entry.repository.name,
      },
    })
    await options.updateDelivery(provisioned.linkId, {
      ...result,
      pushedAt: result.pushStatus === 'pushed' ? new Date().toISOString() : null,
      lastAttemptAt: new Date().toISOString(),
    })
    const commitFailed = ['git_status_failed', 'git_stage_failed', 'git_commit_failed', 'git_head_failed']
      .includes(result.failureCode ?? '')
    await options.updateDelivery(provisioned.linkId, {
      operationCheckpoint: {
        operation: 'commit',
        status: commitFailed ? 'failed' : 'completed',
        ...(result.headCommit ? { commit: result.headCommit } : {}),
        ...(commitFailed && result.failureSummary ? { summary: result.failureSummary } : {}),
      },
    })
    await options.updateDelivery(provisioned.linkId, {
      operationCheckpoint: {
        operation: 'push',
        status: result.pushStatus === 'pushed'
          ? 'completed'
          : result.pushStatus === 'not_needed'
            ? 'skipped'
            : 'failed',
        ...(result.pushedCommit ? { commit: result.pushedCommit } : {}),
        ...(result.pushStatus === 'failed' && result.failureSummary ? { summary: result.failureSummary } : {}),
      },
    })
    await options.updateDelivery(provisioned.linkId, {
      operationCheckpoint: {
        operation: 'pull_request',
        status: result.deliveryStatus === 'in_review'
          ? 'completed'
          : result.deliveryStatus === 'failed' && result.pushStatus === 'pushed'
            ? 'failed'
            : 'skipped',
        ...(result.failureSummary ? { summary: result.failureSummary } : {}),
      },
    })
    results.push({ linkId: provisioned.linkId, result })
  }
  return results
}
