import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from './client.js'
import type { Config } from './config.js'
import { buildAiEnvironment, redactSensitiveOutput } from './repository-credentials.js'
import { createTaskAccessBroker, type TaskCapability } from './task-access-broker.js'

/** Task access is isolated; AI CLIs retain their operator-selected authenticated configuration. */
export async function createTaskWorkerAccess(options: {
  config: Config
  daemonId: string
  requirementId: string
  taskId?: string
  sharedCapabilityReads?: boolean
  capabilityExecution?: boolean
  runId: string
  workerIndex: number
  leaseGeneration: number
  controlledGit?: (input: { operation: 'fetch' | 'verify'; repositoryId: string }) => Promise<unknown>
  signal?: AbortSignal
}): Promise<{ environment: NodeJS.ProcessEnv; signal: AbortSignal; redact: (value: string) => string; close: () => Promise<void> }> {
  if (!options.config.apiKey) throw new Error('Task worker requires an authenticated supervisor')
  const credential = { apiUrl: options.config.apiUrl, apiKey: options.config.apiKey }
  const endpoint = `/api/v1/daemons/${options.daemonId}/delegations`
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const root = await mkdtemp(join(tmpdir(), 'tw-task-worker-'))
  const secrets = new Set([credential.apiKey])
  let broker: Awaited<ReturnType<typeof createTaskAccessBroker>> | undefined
  try {
    const capability = await request<TaskCapability>('POST', endpoint, {
      requirementId: options.requirementId, taskId: options.taskId, runId: options.runId,
      sharedCapabilityReads: options.sharedCapabilityReads ?? false, capabilityExecution: options.capabilityExecution ?? false,
      workerIndex: options.workerIndex, leaseGeneration: options.leaseGeneration,
    }, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
    secrets.add(capability.token)
    broker = await createTaskAccessBroker({ apiUrl: credential.apiUrl, capability, controlledGit: options.controlledGit,
      renew: async id => {
        const next = await request<TaskCapability>('POST', `${endpoint}/${id}/renew`, {}, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
        secrets.add(next.token)
        return next
      },
      revoke: id => request('DELETE', `${endpoint}/${id}`, undefined, { credential, signal: AbortSignal.timeout(2500) }),
      onInvalidation: () => controller.abort(new Error('Task execution authority ended')),
    })
    secrets.add(broker.apiKey)
    const home = join(root, 'home')
    await mkdir(home, { mode: 0o700 })
    const environment = buildAiEnvironment(process.env, {
      HOME: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      CODEX_HOME: process.env.TW_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      CLAUDE_CONFIG_DIR: process.env.TW_CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      TW_CONFIG_DIR: join(root, 'tw'), TW_API_URL: broker.apiUrl, TW_API_KEY: broker.apiKey,
      TW_NODE_ID: options.config.nodeId,
      TW_ARTIFACT_ROOT: process.env.TW_ARTIFACT_ROOT ?? join(homedir(), '.task-weaver', 'artifacts'),
      TW_TASK_ID: options.taskId, TW_DAEMON_ID: options.daemonId, TW_DAEMON_RUN_ID: options.runId,
      TW_REQUIREMENT_LEASE_GENERATION: String(options.leaseGeneration),
      CI: process.env.CI ?? '1', NO_COLOR: '1', TERM: 'xterm-256color',
    })
    return { environment, signal: controller.signal,
      redact: (value: string) => {
        for (const secret of secrets) value = value.split(secret).join('[redacted]')
        return redactSensitiveOutput(value)
      },
      async close() {
        options.signal?.removeEventListener('abort', abort)
        controller.abort(new Error('Task worker finished'))
        await broker!.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch {
    options.signal?.removeEventListener('abort', abort)
    await broker?.close()
    await rm(root, { recursive: true, force: true })
    throw new Error('Task execution access unavailable')
  }
}
