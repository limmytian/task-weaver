import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, ApiTransportError, request } from './client.js'
import type { Config } from './config.js'
import { ExecutorSignalCollector, queryCodexQuota } from './executor-availability.js'
import { runCommand } from './async-command.js'
import { buildAiEnvironment } from './repository-credentials.js'
import { normalizeRequirementRepositoryEntries, provisionThinWorkspace, verifyThinWorkspaceBaselines } from './repository-workspace.js'
import { readThinCooldown, writeThinCooldown } from './thin-worker-cooldown.js'
import { applyThinDeliveries, captureThinPatches, packageThinArtifacts, publishThinArtifact } from './thin-workspace-artifacts.js'
import { workerAcceptanceDecisionSchema, workerPlanSchema } from '@task-weaver/contracts'

interface ThinAttempt { id: string; workerId: string; requirementId: string; taskId: string; planRevision: number }
interface ThinTask { id: string; title: string; description: string | null; requirementId: string; tags: string[] | null }
interface ThinLane { attempt: ThinAttempt | null; task: ThinTask | null; token?: string }
export type ThinOnceOutcome = { state: 'empty' | 'completed' | 'attention' | 'cooldown'; taskId?: string; attemptId?: string; reason?: string; workspacePath?: string; retryAt?: string | null; usage?: 'known' | 'unknown' }
export interface ThinExecutor {
  preflight(environment: NodeJS.ProcessEnv): Promise<{ blocked: boolean; reason: string; retryAt: string | null; usage?: 'known' | 'unknown' }>
  execute(input: { prompt: string; cwd: string; environment: NodeJS.ProcessEnv; model: string; effort: string; signal: AbortSignal; timeoutMs: number }): Promise<{ ok: boolean; reason: string; quotaBlocked: boolean }>
}

async function readBoundedJson(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Task output is invalid or too large')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset !== info.size) throw new Error('Task output changed while reading')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown
  } finally { await file.close() }
}

/** No TW credentials are sent to the executor; only the worker may publish results. */
export function codexThinExecutor(): ThinExecutor {
  return {
    async preflight(environment) {
      const version = await runCommand('codex', ['--version'], { env: environment, timeoutMs: 5000, maxOutputBytes: 1024 })
      if (!version.ok) return { blocked: true, reason: 'Codex is unavailable', retryAt: null }
      const observation = await queryCodexQuota(createHash('sha256').update(environment.CODEX_HOME ?? 'codex').digest('hex'), environment)
      return { blocked: observation.state === 'cooling_down' || observation.state === 'action_required', reason: observation.reason, retryAt: observation.resetAt, usage: observation.windows.length ? 'known' : 'unknown' }
    },
    async execute(input) {
      const controller = new AbortController()
      const collector = new ExecutorSignalCollector('codex', 'thin-worker', () => controller.abort(new Error('Executor resources unavailable')))
      const signal = AbortSignal.any([input.signal, controller.signal])
      const args = ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', '--color', 'never', '-C', input.cwd, '--model', input.model, '-c', `model_reasoning_effort="${input.effort}"`, input.prompt]
      const result = await runCommand('codex', args, { cwd: input.cwd, env: input.environment, signal, timeoutMs: input.timeoutMs, maxOutputBytes: 0, onStdout: chunk => collector.push('stdout', chunk), onStderr: chunk => collector.push('stderr', chunk) })
      const observation = collector.finish()
      return { ok: result.ok && !observation, reason: observation?.reason ?? (result.timedOut ? 'Executor timed out' : input.signal.aborted ? 'Execution authority or connection ended' : result.ok ? 'Executor completed' : 'Executor exited without a usable result'), quotaBlocked: observation?.state === 'cooling_down' || observation?.state === 'action_required' }
    },
  }
}

export type ThinWorkerPhase = 'preflight' | 'acquiring' | 'preparing' | 'executing' | 'publishing'

export async function runThinOnce(options: { config: Config; projectId: string; requirementId?: string; model: string; effort: string; timeoutMs: number; executor?: ThinExecutor; signal?: AbortSignal; workerId?: string; heartbeatIntervalMs?: number; onPhase?: (phase: ThinWorkerPhase) => Promise<void> }): Promise<ThinOnceOutcome> {
  if (!options.config.apiKey || !options.config.nodeId) throw new Error('Thin worker requires an API key and node identity')
  const credential = { apiUrl: options.config.apiUrl, apiKey: options.config.apiKey }
  const workerId = options.workerId ?? randomUUID()
  const childRoot = await mkdtemp(join(tmpdir(), 'tw-thin-executor-'))
  const home = join(childRoot, 'home'); await mkdir(home, { mode: 0o700 })
  const environment = buildAiEnvironment(process.env, { HOME: home, XDG_CONFIG_HOME: join(childRoot, 'config'), XDG_DATA_HOME: join(childRoot, 'data'), CODEX_HOME: process.env.TW_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), TW_CONFIG_DIR: join(childRoot, 'tw'), CI: '1', NO_COLOR: '1', TERM: 'xterm-256color' })
  const executor = options.executor ?? codexThinExecutor()
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  try {
    await options.onPhase?.('preflight')
    const codexHome = environment.CODEX_HOME ?? ''
    const cooldown = await readThinCooldown(options.config.nodeId, codexHome)
    if (cooldown) return { state: 'cooldown', reason: 'Executor is cooling down', retryAt: cooldown, usage: 'unknown' }
    const preflight = await executor.preflight(environment)
    const usage = preflight.usage ?? 'unknown'
    if (preflight.blocked) return { state: 'cooldown', reason: preflight.reason, retryAt: await writeThinCooldown(options.config.nodeId, codexHome, preflight.retryAt), usage }
    await options.onPhase?.('acquiring')
    const lane = await request<ThinLane>('POST', '/api/v1/thin-workers/acquire', { projectId: options.projectId, ...(options.requirementId ? { requirementId: options.requirementId } : {}), workerId, nodeId: options.config.nodeId, executor: 'codex', model: options.model, durationSeconds: 120 }, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
    if (!lane.attempt || !lane.task || !lane.token) return { state: 'empty', usage }
    const attempt = lane.attempt, task = lane.task, fence = { attemptId: attempt.id, workerId, token: lane.token }
    let workspacePath: string | undefined
    const heartbeat = async () => { await request('POST', '/api/v1/thin-workers/heartbeat', { ...fence, durationSeconds: 120 }, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) }) }
    timer = setInterval(() => {
      if (inFlight || controller.signal.aborted) return
      inFlight = heartbeat().catch(() => { controller.abort(new Error('Attempt heartbeat failed; inspect preserved workspace')) }).finally(() => { inFlight = undefined })
    }, options.heartbeatIntervalMs ?? 30000)
    const finish = async (reason: string, quotaBlocked = false): Promise<ThinOnceOutcome> => {
      const handoff = workspacePath ? `${reason}. Local workspace on ${options.config.nodeId}: ${workspacePath}` : reason
      if (!controller.signal.aborted) {
        try { await request('POST', '/api/v1/thin-workers/release', { ...fence, resultKey: randomUUID(), reason: handoff }, { credential, signal: AbortSignal.timeout(10000) }) } catch { /* The lease may have expired or the release may have committed. */ }
      }
      const retryAt = quotaBlocked ? await writeThinCooldown(options.config.nodeId!, codexHome, null) : undefined
      return { state: quotaBlocked ? 'cooldown' : 'attention', taskId: task.id, attemptId: attempt.id, reason: handoff, workspacePath, retryAt, usage }
    }
    try {
      await options.onPhase?.('preparing')
      await heartbeat()
      const requirement = await request<{ id: string; title: string; description: string | null }>('GET', `/api/v1/requirements/${attempt.requirementId}`, undefined, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      const rawEntries = await request<unknown[]>('GET', `/api/v1/requirements/${attempt.requirementId}/repositories`, undefined, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      const entries = normalizeRequirementRepositoryEntries(rawEntries)
      const workspace = await provisionThinWorkspace({ config: options.config, projectId: options.projectId, requirementId: attempt.requirementId, taskId: task.id, attemptId: attempt.id, planRevision: attempt.planRevision, entries, assertAuthority: heartbeat, signal: controller.signal })
      workspacePath = workspace.rootPath
      const coordinator = task.tags?.includes('worker:coordinator') === true
      const acceptance = task.tags?.includes('worker:acceptance') === true
      if (acceptance) {
        const response = await request<{ inputs: Array<{ taskId: string; outputId: string; documentId: string; fileVersion: number; sha256: string; sizeBytes: number; mimeType: string; originalFilename: string; kind: 'worker' | 'human' }> }>('POST', '/api/v1/thin-workers/inputs', fence, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        const inputRoot = join(workspace.rootPath, 'inputs'); await mkdir(inputRoot, { mode: 0o700 })
        const packages: string[] = []
        const manifest: Array<Record<string, unknown>> = []
        for (const input of response.inputs) {
          if (!/^[0-9a-f-]{36}$/i.test(input.outputId) || !/^[0-9a-f-]{36}$/i.test(input.documentId) || !Number.isSafeInteger(input.fileVersion) || input.fileVersion < 1 || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 50 * 1024 * 1024) throw new Error('Invalid acceptance evidence metadata')
          await heartbeat()
          const query = new URLSearchParams({ fileVersion: String(input.fileVersion) })
          const download = await fetch(`${credential.apiUrl}/api/v1/documents/${input.documentId}/file?${query}`, { headers: { authorization: `Bearer ${credential.apiKey}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
          if (!download.ok || !download.body) throw new Error('Acceptance evidence download failed')
          const reader = download.body.getReader(), chunks: Buffer[] = []
          let size = 0
          try {
            for (;;) {
              const part = await reader.read()
              if (part.done) break
              size += part.value.byteLength
              if (size > input.sizeBytes || size > 50 * 1024 * 1024) throw new Error('Acceptance evidence exceeds its declared size')
              chunks.push(Buffer.from(part.value))
            }
          } finally { await reader.cancel().catch(() => undefined) }
          const bytes = Buffer.concat(chunks)
          if (bytes.length !== input.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('Acceptance evidence checksum mismatch')
          const filename = `${input.outputId}.${input.kind === 'worker' ? 'json' : 'bin'}`
          const path = join(inputRoot, filename)
          const file = await open(path, 'wx', 0o600)
          try { await file.writeFile(bytes) } finally { await file.close() }
          manifest.push({ taskId: input.taskId, outputId: input.outputId, filename, kind: input.kind, mimeType: input.mimeType, originalFilename: input.originalFilename, sha256: input.sha256 })
          if (input.kind === 'worker') packages.push(path)
        }
        await writeFile(join(inputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        if (packages.length) await applyThinDeliveries({ workspace, projectId: options.projectId, requirementId: attempt.requirementId, taskId: task.id, attemptId: attempt.id, planRevision: attempt.planRevision, packages, assertAuthority: heartbeat, assertBaseline: () => verifyThinWorkspaceBaselines({ config: options.config, workspace, entries, assertAuthority: heartbeat, signal: controller.signal }) })
      }
      const planInstructions = coordinator ? `\nThis is a coordinator task. Write plan.json at the workspace root using this shape: {"projectId":"${options.projectId}","requirements":[{"key":"current","existingId":"${attempt.requirementId}","tasks":[{"key":"implementation","title":"...","description":"..."},{"key":"acceptance","title":"...","tags":["worker:acceptance"],"dependsOn":["implementation"]}]}]}. Include one acceptance task that directly blocks on every other new task. Only create new tasks in this requirement; do not include documents, assignments, existing tasks or slices. Record contracts and acceptance criteria in the task descriptions and result.md.` : ''
      const acceptanceInstructions = acceptance ? '\nThis is an acceptance task. Review the verified dependency artifacts under inputs/ and the staged integration workspace. Run appropriate checks and explain the evidence and any unresolved findings in result.md. Write decision.json at the workspace root as {"decision":"accept" or "changes_requested","summary":"..."}. Use changes_requested whenever findings remain or evidence is insufficient.' : ''
      const prompt = `You are executing one bounded Task Weaver task. Work only in this isolated workspace. Do not use TW credentials, push, merge, commit, or perform external side effects. Leave repository changes uncommitted and write a concise result.md at the workspace root describing changes, verification and limitations. Do not claim completion without evidence.\nRequirement: ${requirement.title}\n${requirement.description ?? ''}\nTask: ${task.title}\n${task.description ?? ''}\nWorkspace: ${workspace.rootPath}\nRepository manifest: ${workspace.manifestPath}${planInstructions}${acceptanceInstructions}`
      await options.onPhase?.('executing')
      const execution = await executor.execute({ prompt, cwd: workspace.rootPath, environment, model: options.model, effort: options.effort, signal: controller.signal, timeoutMs: options.timeoutMs })
      if (!execution.ok || controller.signal.aborted) return finish(execution.reason, execution.quotaBlocked)
      await options.onPhase?.('publishing')
      await heartbeat()
      if (coordinator) {
        const plan = await readBoundedJson(join(workspace.rootPath, 'plan.json'), 1024 * 1024)
        const submission = workerPlanSchema.parse({ ...fence, operationKey: attempt.id, expectedRevision: attempt.planRevision, plan })
        try {
          await request('POST', '/api/v1/thin-workers/plan', submission, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        } catch (error) {
          if (!(error instanceof ApiTransportError) || !error.mutationMayHaveCommitted || controller.signal.aborted) throw error
          await request('POST', '/api/v1/thin-workers/plan', submission, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        }
      }
      await verifyThinWorkspaceBaselines({ config: options.config, workspace, entries, assertAuthority: heartbeat, signal: controller.signal })
      const patches = await captureThinPatches(workspace, heartbeat)
      const reportPath = join(workspace.rootPath, 'result.md')
      const reportExists = await stat(reportPath).then(value => value.isFile()).catch(() => false)
      const decision = acceptance ? workerAcceptanceDecisionSchema.parse(await readBoundedJson(join(workspace.rootPath, 'decision.json'), 16384)) : null
      if ((coordinator || acceptance) && !reportExists) return finish('Coordinator or acceptance task exited without its required report')
      if (!patches.length && !reportExists) return finish('Executor exited without a task artifact')
      const packagePath = await packageThinArtifacts(workspace, patches, heartbeat, reportExists ? reportPath : undefined)
      const output = await publishThinArtifact({ ...credential, projectId: options.projectId, ...fence, path: packagePath, assertAuthority: heartbeat, signal: controller.signal })
      try {
        await request('POST', '/api/v1/thin-workers/result', { ...fence, resultKey: randomUUID(), outcome: decision?.decision === 'changes_requested' ? 'attention' : 'done', summary: decision?.summary ?? 'Task artifact submitted for review', outputId: output.outputId, ...(decision ? { acceptanceDecision: decision.decision } : {}) }, { credential, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      } catch (error) {
        if (error instanceof ApiTransportError && error.mutationMayHaveCommitted) return { state: 'attention', taskId: task.id, attemptId: attempt.id, reason: 'Result response was lost; inspect the attempt before taking further action', workspacePath, usage }
        throw error
      }
      return { state: decision?.decision === 'changes_requested' ? 'attention' : 'completed', taskId: task.id, attemptId: attempt.id, workspacePath, usage, ...(decision?.decision === 'changes_requested' ? { reason: 'Acceptance requested changes; inspect the recorded artifact' } : {}) }
    } catch (error) {
      const reason = controller.signal.aborted ? 'Attempt interrupted; inspect the preserved workspace and external effects'
        : error instanceof ApiTransportError ? 'TW connection interrupted; inspect the preserved workspace and attempt state'
        : error instanceof ApiError && [401, 403].includes(error.status) ? 'Worker authorization ended; inspect the attempt and credentials'
        : error instanceof ApiError && error.status === 409 ? 'Plan or dependency evidence changed; inspect the current task and retry only after review'
        : error instanceof Error && error.message.includes('baseline changed') ? 'Integration baseline changed; revalidate the preserved workspace'
        : 'Task preparation or delivery failed; inspect the preserved workspace'
      return finish(reason)
    }
  } finally {
    if (timer) clearInterval(timer)
    await inFlight
    controller.abort()
    options.signal?.removeEventListener('abort', abort)
    await rm(childRoot, { recursive: true, force: true })
  }
}
