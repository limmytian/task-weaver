import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiError, ApiTransportError, request } from './client.js'
import type { Config } from './config.js'
import { integrateThinTarget, prepareThinPushSandbox, pushThinDelivery } from './thin-git-delivery.js'
import { createThinPushRunner, fetchThinVersionTarget, type CompositeWorkspace, type RequirementRepositoryEntry } from './repository-workspace.js'

export interface ThinIntegrationSource { repositoryId: string; sourceBranch: string; sourceCommit: string; targetBranch: string }

/** Integrate one server-accepted commit into its configured version branch. */
export async function deliverThinVersion(options: {
  config: Config
  workspace: CompositeWorkspace
  entries: RequirementRepositoryEntry[]
  source: ThinIntegrationSource
  fence: { attemptId: string; workerId: string; token: string }
  identity: { name: string; email: string }
  assertAuthority: () => Promise<void>
  resolveConflict: (cwd: string) => Promise<void>
  signal?: AbortSignal
}) {
  const { source } = options
  const repository = options.workspace.repositories.find(item => item.repositoryId === source.repositoryId)
  const entry = options.entries.find(item => item.repository.id === source.repositoryId && item.link.id === repository?.linkId)
  if (!repository || !entry || repository.headCommit !== source.sourceCommit || repository.baseBranch !== source.sourceBranch || !options.config.apiKey) throw new Error('Accepted integration workspace does not match the source snapshot')
  const credential = { apiUrl: options.config.apiUrl, apiKey: options.config.apiKey }
  const post = <T>(path: string, body: unknown) => request<T>('POST', `/api/v1/thin-workers/${path}`, body, { credential, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
  let head = source.sourceCommit
  for (let attempt = 0; attempt < 20; attempt++) {
    await options.assertAuthority()
    const target = await fetchThinVersionTarget({ ...options, repositoryId: source.repositoryId, sourceBranch: source.sourceBranch, targetBranch: source.targetBranch })
    const integrated = await integrateThinTarget({ cwd: repository.worktreePath, taskCommit: head, targetCommit: target, identity: options.identity, assertAuthority: options.assertAuthority, resolveConflict: () => options.resolveConflict(repository.worktreePath), signal: options.signal })
    head = integrated.commit
    const preparation = { ...options.fence, operationKey: randomUUID(), repositoryId: source.repositoryId, expectedHead: target, proposedHead: head }
    let delivery: { id: string }
    try {
      try { delivery = await post('integration/prepare', preparation) }
      catch (error) {
        if (!(error instanceof ApiTransportError) || !error.mutationMayHaveCommitted || options.signal?.aborted) throw error
        delivery = await post('integration/prepare', preparation)
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'Branch delivery is occupied or requires inspection') throw error
      await delay(250, undefined, { signal: options.signal })
      continue
    }
    let authorizationSent = false
    let sandbox: Awaited<ReturnType<typeof prepareThinPushSandbox>> | undefined
    try {
      sandbox = await prepareThinPushSandbox({ source: repository.worktreePath, commit: head, assertAuthority: options.assertAuthority, signal: options.signal })
      const runner = createThinPushRunner({ config: options.config, entry, gitDir: sandbox.gitDir, signal: options.signal })
      const result = await pushThinDelivery({ targetBranch: source.targetBranch, expectedHead: target, proposedHead: head, remote: runner.remote, git: runner.git,
        authorizePush: async () => { authorizationSent = true; const response = await post<{ shouldPush: boolean }>('integration/authorize', { ...options.fence, deliveryId: delivery.id }); return response.shouldPush },
        markUncertain: async () => { await post('git/transition', { ...options.fence, deliveryId: delivery.id, event: 'response_lost' }) },
      })
      if (result.state === 'uncertain') return { state: 'uncertain' as const, repositoryId: source.repositoryId, deliveryId: delivery.id, commit: head }
      await post('git/confirm', { ...options.fence, deliveryId: delivery.id })
      return { state: 'confirmed' as const, repositoryId: source.repositoryId, deliveryId: delivery.id, commit: head }
    } catch (error) {
      if (!authorizationSent) {
        const abandoned = await post<{ delivery: { state: string } }>('git/transition', { ...options.fence, deliveryId: delivery.id, event: 'definitely_not_started' }).catch(() => undefined)
        if (abandoned?.delivery.state === 'abandoned' && error instanceof Error && error.message === 'Target branch advanced; integrate its latest commit') continue
      }
      throw error
    } finally { await sandbox?.cleanup() }
  }
  throw new Error('Version branch remained busy; inspect the delivery and retry after review')
}
