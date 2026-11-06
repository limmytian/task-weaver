import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import { ApiError, ApiTransportError, request } from './client.js'
import { commitThinWorkspace, integrateThinTarget, prepareThinPushSandbox, pushThinDelivery } from './thin-git-delivery.js'
import { createThinPushRunner, fetchThinIntegrationTarget, type CompositeWorkspace, type RequirementRepositoryEntry } from './repository-workspace.js'

/** Deliver one repository using a single attempt-bound push authorization. */
export async function deliverThinGitRepository(options: {
  config: Config
  workspace: CompositeWorkspace
  entries: RequirementRepositoryEntry[]
  repositoryId: string
  fence: { attemptId: string; workerId: string; token: string }
  identity: { name: string; email: string }
  message: string
  assertAuthority: () => Promise<void>
  resolveConflict: (cwd: string) => Promise<void>
  signal?: AbortSignal
}) {
  const repository = options.workspace.repositories.find(item => item.repositoryId === options.repositoryId)
  const entry = options.entries.find(item => item.repository.id === options.repositoryId && item.link.id === repository?.linkId)
  if (!repository?.headCommit || !entry || !entry.link.workingBranch) throw new Error('Task repository or requirement branch is unavailable')
  if (!options.config.apiKey) throw new Error('Worker credential is unavailable')
  const credential = { apiUrl: options.config.apiUrl, apiKey: options.config.apiKey }
  const post = <T>(path: string, body: unknown) => request<T>('POST', `/api/v1/thin-workers/git/${path}`, body, { credential, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
  const task = await commitThinWorkspace({ cwd: repository.worktreePath, baseline: repository.headCommit, message: options.message, identity: options.identity, assertAuthority: options.assertAuthority, signal: options.signal })
  if (!task.changed) return { state: 'unchanged' as const, repositoryId: repository.repositoryId, commit: task.commit }
  let taskCommit = task.commit
  for (let attempt = 0; attempt < 20; attempt++) {
    await options.assertAuthority()
    const target = await fetchThinIntegrationTarget({ config: options.config, workspace: options.workspace, entries: options.entries, repositoryId: repository.repositoryId, assertAuthority: options.assertAuthority, signal: options.signal })
    const integrated = await integrateThinTarget({ cwd: repository.worktreePath, taskCommit, targetCommit: target, identity: options.identity, assertAuthority: options.assertAuthority, resolveConflict: () => options.resolveConflict(repository.worktreePath), signal: options.signal })
    taskCommit = integrated.commit
    const preparation = { ...options.fence, operationKey: randomUUID(), repositoryId: repository.repositoryId, targetBranch: entry.link.workingBranch, expectedHead: target, proposedHead: integrated.commit }
    let delivery: { id: string }
    try {
      try { delivery = await post('prepare', preparation) }
      catch (error) {
        if (!(error instanceof ApiTransportError) || !error.mutationMayHaveCommitted || options.signal?.aborted) throw error
        delivery = await post('prepare', preparation)
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'Branch delivery is occupied or requires inspection') throw error
      await delay(250, undefined, { signal: options.signal })
      continue
    }
    let authorizationSent = false
    let sandbox: Awaited<ReturnType<typeof prepareThinPushSandbox>> | undefined
    try {
      sandbox = await prepareThinPushSandbox({ source: repository.worktreePath, commit: integrated.commit, assertAuthority: options.assertAuthority, signal: options.signal })
      const runner = createThinPushRunner({ config: options.config, entry, gitDir: sandbox.gitDir, signal: options.signal })
      const result = await pushThinDelivery({ targetBranch: entry.link.workingBranch, expectedHead: target, proposedHead: integrated.commit, remote: runner.remote, git: runner.git,
        authorizePush: async () => {
          authorizationSent = true
          const response = await post<{ shouldPush: boolean }>('transition', { ...options.fence, deliveryId: delivery.id, event: 'start_push' })
          return response.shouldPush
        },
        markUncertain: async () => { await post('transition', { ...options.fence, deliveryId: delivery.id, event: 'response_lost' }) },
      })
      if (result.state === 'uncertain') return { state: 'uncertain' as const, repositoryId: repository.repositoryId, deliveryId: delivery.id, commit: integrated.commit }
      await post('confirm', { ...options.fence, deliveryId: delivery.id })
      return { state: 'confirmed' as const, repositoryId: repository.repositoryId, deliveryId: delivery.id, commit: integrated.commit }
    } catch (error) {
      if (!authorizationSent) {
        // Retry only after the server confirms that no external push was authorized.
        const abandoned = await post<{ delivery: { state: string } }>('transition', { ...options.fence, deliveryId: delivery.id, event: 'definitely_not_started' }).catch(() => undefined)
        if (abandoned?.delivery.state === 'abandoned' && error instanceof Error && error.message === 'Target branch advanced; integrate its latest commit') continue
      }
      throw error
    } finally { await sandbox?.cleanup() }
  }
  throw new Error('Requirement branch remained busy; inspect the delivery and retry after review')
}
