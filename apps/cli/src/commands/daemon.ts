import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { homedir, hostname } from 'os'
import { join, resolve } from 'path'
import { Command } from 'commander'
import { runCommand } from '../async-command.js'
import { commandFailureSummary } from '../daemon-finalization.js'
import {
  DaemonLifecycle,
  cancellationReason,
  throwIfCancelled,
} from '../daemon-lifecycle.js'
import { LeaseSupervisor, type LeaseHealthSnapshot } from '../lease-supervisor.js'
import { get, request } from '../client.js'
import { loadConfig, type Config } from '../config.js'
import {
  mergeRequirementBranch,
  parseReviewDecision,
  reviewRequirementBranch,
  runShellCommand,
  type ReviewDecision,
} from '../daemon-review.js'
import { printJson, printTable } from '../output.js'
import { getGitProviderAdapter, runTrustedGitCommand } from '../git-provider.js'
import type { ForgeFailure, ForgePullRequest } from '../git-provider.js'
import {
  buildAiEnvironment,
  redactTrustedOutput,
  resolveRepositoryCredential,
} from '../repository-credentials.js'
import {
  finalizeCompositeWorkspace,
  inspectCompositeWorkspace,
  normalizeRequirementRepositoryEntries,
  provisionCompositeWorkspace,
  withRepositoryWorkspaceLock,
  type RequirementRepositoryEntry,
} from '../repository-workspace.js'
import { registerDaemonPipeline } from './daemon-pipeline.js'
import {
  manualMergeActionUrl,
  selectMergeMode,
  type EffectiveMergePolicy,
  type RequestedMergeMode,
} from '../daemon-merge-policy.js'

interface DaemonConfig {
  mode: 'polling' | 'sse'
  pollingIntervalMs: number
  pollingBackoffMax: number
  sseEndpoint?: string
}

type DaemonRole = 'executor' | 'reviewer' | 'merger'

interface DaemonProcessIdentity {
  actorId: string
  instanceId: string
  processStartedAt: string
  role: DaemonRole
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function forgeSyncIdempotencyKey(pullRequest: ForgePullRequest) {
  const digest = createHash('sha256').update(JSON.stringify(pullRequest)).digest('hex')
  return `${pullRequest.provider}:${pullRequest.externalId}:${digest}`
}

export function resolveDaemonProcessIdentity(
  role: DaemonRole,
  explicitId: string | undefined,
  config: Pick<Config, 'actorId' | 'clientId' | 'daemonInstanceIds'>,
  env: Record<string, string | undefined> = process.env,
  generateId: () => string = randomUUID,
  now: () => Date = () => new Date(),
): DaemonProcessIdentity {
  const roleEnvKey = `TW_DAEMON_${role.toUpperCase()}_ID`
  const configuredId =
    explicitId ??
    env[roleEnvKey] ??
    config.daemonInstanceIds?.[role] ??
    env.TW_DAEMON_ID

  if (configuredId && !UUID_PATTERN.test(configuredId)) {
    throw new Error(
      `Invalid daemon instance ID '${configuredId}' for role '${role}'. Expected a UUID.`,
    )
  }

  return {
    actorId: config.actorId ?? config.clientId ?? 'tw-cli',
    instanceId: configuredId ?? generateId(),
    processStartedAt: now().toISOString(),
    role,
  }
}

interface WorkerState {
  index: number
  currentRequirementId: string | null
  currentExecutionSliceId: string | null
  currentTaskId: string | null
  requirementTitle: string | null
  executionSliceTitle: string | null
  taskTitle: string | null
  modelTier: string | null
  model: string | null
  reasoningEffort: string | null
  runId: string | null
  leaseGeneration: number | null
  leaseHealthy: boolean | null
  leaseHeartbeatFailures: number
  lastLeaseError: string | null
  branchName: string | null
  worktreePath: string | null
  startedAt: string | null
  activeProcess: boolean
  pollTimer: ReturnType<typeof setTimeout> | null
  currentInterval: number
  polling: boolean
  lastEligibilitySummary: string | null
}

interface RequirementLane {
  requirement: any
  executionSlice?: any | null
  task: any
  tasks: any[]
  repositories: RequirementRepositoryEntry[]
  executorTool?: string | null
  leaseGeneration: number
  runId?: string
}

interface SchedulerEligibilityDiagnostics {
  candidateCount: number
  examinedCount: number
  runnableCount: number
  selectedCount: number
  truncated: boolean
  skipCounts: Record<string, number>
}

export function selectExecutorTool(
  tools: string[],
  taskTags: string[] = [],
  serverSelection?: string | null,
) {
  if (serverSelection && tools.includes(serverSelection)) return serverSelection
  const allowed = taskTags.flatMap((tag) => {
    if (tag.startsWith('executor:')) return [tag.slice('executor:'.length)]
    if (tag.startsWith('tool:')) return [tag.slice('tool:'.length)]
    return []
  })
  return tools.find((tool) => allowed.length === 0 || allowed.includes(tool)) ?? null
}

interface ReviewWorkerState {
  index: number
  currentRequirementId: string | null
  requirementTitle: string | null
  branchName: string | null
  worktreePath: string | null
  startedAt: string | null
  activeProcess: boolean
  leaseGeneration: number | null
  leaseHealthy: boolean | null
  leaseHeartbeatFailures: number
  lastLeaseError: string | null
}

function applyLeaseSnapshot(
  worker: Pick<WorkerState, 'leaseHealthy' | 'leaseHeartbeatFailures' | 'lastLeaseError'>,
  snapshot: LeaseHealthSnapshot,
) {
  worker.leaseHealthy = snapshot.healthy
  worker.leaseHeartbeatFailures = snapshot.heartbeatFailures
  worker.lastLeaseError = snapshot.lastError
}

export const KNOWN_AI_TOOLS = ['codex', 'claude', 'agy', 'aider', 'cursor'] as const
export type KnownAiTool = (typeof KNOWN_AI_TOOLS)[number]

export function resolveToolPath(command: string): string | null {
  const searchPaths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  for (const directory of searchPaths) {
    const candidate = join(directory, `${command}${suffix}`)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Continue checking next directory
    }
  }
  return null
}

export function detectTools(): string[] {
  return KNOWN_AI_TOOLS.filter((command) => Boolean(resolveToolPath(command)))
}

export interface DetectedToolReport {
  tool: string
  installed: boolean
  path: string | null
  status: 'available' | 'unavailable' | 'not_found'
  reason?: string
}

export async function inspectTools(
  tools: readonly string[] = KNOWN_AI_TOOLS,
  runner?: ExecutorPreflightRunner,
): Promise<DetectedToolReport[]> {
  const reports: DetectedToolReport[] = []
  for (const tool of tools) {
    const toolPath = resolveToolPath(tool)
    if (!toolPath) {
      reports.push({
        tool,
        installed: false,
        path: null,
        status: 'not_found',
      })
      continue
    }

    const preflight = await preflightExecutorTools([tool], runner)
    if (preflight.runnable.includes(tool)) {
      reports.push({
        tool,
        installed: true,
        path: toolPath,
        status: 'available',
      })
    } else {
      const failure = preflight.unavailable.find((u) => u.tool === tool)
      reports.push({
        tool,
        installed: true,
        path: toolPath,
        status: 'unavailable',
        reason: failure?.reason,
      })
    }
  }
  return reports
}


type ExecutorPreflightRunner = (
  command: string,
  args: string[],
) => Promise<{ status: number | null; timedOut: boolean; errorCode?: string }>;

export async function preflightExecutorTools(
  tools: string[],
  runner: ExecutorPreflightRunner = (command, args) => runCommand(command, args, {
    timeoutMs: 30_000,
    killGraceMs: 1_000,
    maxOutputBytes: 64 * 1024,
  }),
) {
  const uniqueTools = [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))]
  const checks = await Promise.all(uniqueTools.map(async (tool) => {
    const result = await runner(tool, ['--version'])
    const runnable = !result.timedOut && !result.errorCode && result.status !== null
    return { tool, runnable, result }
  }))
  return {
    runnable: checks.filter((check) => check.runnable).map((check) => check.tool),
    unavailable: checks.filter((check) => !check.runnable).map((check) => ({
      tool: check.tool,
      reason: check.result.timedOut
        ? 'preflight timed out'
        : check.result.errorCode
          ? `spawn failed (${check.result.errorCode})`
          : 'process did not start',
    })),
  }
}

export function shouldExecutorWorkerPoll(once: boolean, workerIndex: number) {
  return !once || workerIndex === 0
}

export function formatEligibilityDiagnostics(diagnostics: SchedulerEligibilityDiagnostics) {
  const skipped = Object.entries(diagnostics.skipCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ')
  const coverage = diagnostics.truncated
    ? `; examined ${diagnostics.examinedCount}/${diagnostics.candidateCount}`
    : ''
  return `${diagnostics.candidateCount} candidates, ${diagnostics.runnableCount} runnable${coverage}`
    + (skipped ? `; skipped ${skipped}` : '')
}

function startRoleRetryWakeStream(options: {
  apiUrl: string
  endpoint?: string
  apiKey?: string
  daemonId: string
  role: DaemonRole
  onWake: () => void
}): () => void {
  const ssePath = options.endpoint || '/api/v1/daemons/events'
  const sseUrl = `${options.apiUrl}${ssePath}${ssePath.includes('?') ? '&' : '?'}role=${options.role}`
  const headers: Record<string, string> = {
    'X-Actor-Type': 'agent',
    'X-Actor-Id': options.daemonId,
  }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  const controller = new AbortController()
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const connect = async () => {
    try {
      const response = await fetch(sseUrl, { headers, signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        if (lines.some((line) => line.startsWith('event: repository_retry_requested'))) {
          options.onWake()
        }
      }
    } catch (error) {
      if (!stopped) {
        console.warn(`[Daemon] ${options.role} retry wake stream disconnected:`, error instanceof Error ? error.message : String(error))
      }
    }
    if (!stopped) reconnectTimer = setTimeout(() => { void connect() }, 30_000)
  }

  void connect()
  return () => {
    stopped = true
    controller.abort()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  }
}

// argv template per tool: {prompt} is replaced with the actual prompt string
const TOOL_ARGV_TEMPLATES: Record<string, string[]> = {
  codex: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', '--color', 'never', '-C', '{cwd}', '{prompt}'],
  claude: ['--dangerouslySkipPermissions', '-p', '{prompt}'],
  agy: ['--dangerously-skip-permissions', '-p', '{prompt}'],
  aider: ['--message', '{prompt}'],
  cursor: ['{prompt}'],
}

const MODEL_TIERS = ['fast', 'standard', 'strong'] as const
const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

type ModelTier = (typeof MODEL_TIERS)[number]
type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

function insertBeforePrompt(argv: string[], prompt: string, args: string[]): void {
  const promptIndex = argv.indexOf(prompt)
  if (promptIndex >= 0) argv.splice(promptIndex, 0, ...args)
  else argv.push(...args)
}

export function buildArgv(
  toolCmd: string,
  prompt: string,
  cwd: string,
  model?: string,
  reasoningEffort?: string,
): string[] {
  const template = TOOL_ARGV_TEMPLATES[toolCmd] ?? ['{prompt}']
  const argv = template.map((arg) => {
    if (arg === '{prompt}') return prompt
    if (arg === '{cwd}') return cwd
    return arg
  })
  if (toolCmd === 'codex' && model) {
    insertBeforePrompt(argv, prompt, ['--model', model])
  }
  if (toolCmd === 'codex' && reasoningEffort) {
    insertBeforePrompt(argv, prompt, ['-c', `model_reasoning_effort="${reasoningEffort}"`])
  }
  if (toolCmd === 'agy' && model) {
    const pIndex = argv.indexOf('-p')
    if (pIndex >= 0) {
      argv.splice(pIndex, 0, '--model', model)
    } else {
      insertBeforePrompt(argv, prompt, ['--model', model])
    }
  }
  if (toolCmd === 'agy' && reasoningEffort) {
    const pIndex = argv.indexOf('-p')
    if (pIndex >= 0) {
      argv.splice(pIndex, 0, '--effort', reasoningEffort)
    } else {
      insertBeforePrompt(argv, prompt, ['--effort', reasoningEffort])
    }
  }
  return argv
}

function collectModelMapping(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value)
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function parseModelMappings(values: string[] | undefined): Record<string, string> {
  const mappings: Record<string, string> = {}
  for (const value of values ?? []) {
    const [tier, ...modelParts] = value.split(':')
    const model = modelParts.join(':').trim()
    const normalizedTier = tier?.trim()
    if (!normalizedTier || !isModelTier(normalizedTier) || !model) {
      throw new Error(`Invalid --model mapping "${value}". Use fast:<model>, standard:<model>, or strong:<model>.`)
    }
    mappings[normalizedTier] = model
  }
  return mappings
}

export function parseThinkMappings(values: string[] | undefined): Record<string, CodexReasoningEffort> {
  const mappings: Record<string, CodexReasoningEffort> = {}
  for (const value of values ?? []) {
    const [tier, ...effortParts] = value.split(':')
    const effort = effortParts.join(':').trim()
    const normalizedTier = tier?.trim()
    if (!normalizedTier || !isModelTier(normalizedTier) || !isCodexReasoningEffort(effort)) {
      throw new Error(`Invalid --think mapping "${value}". Use fast:<effort>, standard:<effort>, or strong:<effort>; effort must be one of ${CODEX_REASONING_EFFORTS.join(', ')}.`)
    }
    mappings[normalizedTier] = effort
  }
  return mappings
}

export function loadExtraWorkerPrompt(options: { prompt?: string[]; promptFile?: string[] }): string {
  const fragments: string[] = []
  for (const value of options.prompt ?? []) {
    const trimmed = value.trim()
    if (trimmed) fragments.push(trimmed)
  }
  for (const file of options.promptFile ?? []) {
    const content = readFileSync(resolve(file), 'utf8').trim()
    if (content) fragments.push(content)
  }
  return fragments.join('\n\n')
}

function formatExtraWorkerPromptSection(extraPrompt: string): string {
  if (!extraPrompt.trim()) return ''
  return `Local Extra Worker Instructions:
${extraPrompt.trim()}
`
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'lane'
}

export function daemonProgressPath(options: {
  daemonId?: string
  requirementId?: string
  runId?: string
  workerIndex?: string | number
  history?: boolean
  limit?: string | number
}) {
  const query = new URLSearchParams()
  if (options.daemonId) query.set('daemonId', options.daemonId)
  if (options.requirementId) query.set('requirementId', options.requirementId)
  if (options.runId) query.set('runId', options.runId)
  if (options.workerIndex !== undefined) query.set('workerIndex', String(options.workerIndex))
  query.set('limit', String(options.limit ?? 50))
  return `/api/v1/daemons/progress/${options.history ? 'history' : 'current'}?${query.toString()}`
}

export function daemonHistoryPath(options: {
  daemonId?: string
  requirementId?: string
  runId?: string
  workerIndex?: string | number
  cursor?: string
  since?: string
  until?: string
  severity?: string
  kind?: string
  limit?: string | number
  logs?: boolean
  maxChars?: string | number
}) {
  const query = new URLSearchParams()
  if (options.daemonId) query.set('daemonId', options.daemonId)
  if (options.requirementId) query.set('requirementId', options.requirementId)
  if (options.runId) query.set('runId', options.runId)
  if (options.workerIndex !== undefined) query.set('workerIndex', String(options.workerIndex))
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.since) query.set('since', options.since)
  if (options.until) query.set('until', options.until)
  if (options.severity) query.set('severity', options.severity)
  if (options.kind) query.set('kind', options.kind)
  if (options.maxChars !== undefined) query.set('maxChars', String(options.maxChars))
  query.set('limit', String(options.limit ?? 100))
  return `/api/v1/observability/${options.logs ? 'logs' : 'history'}?${query.toString()}`
}

async function ensureDetachedReviewWorktree(
  basePath: string,
  projectId: string,
  branchName: string,
  baseBranch: string,
  signal?: AbortSignal,
) {
  const worktreeRoot = join(homedir(), '.task-weaver', 'review-worktrees', projectId)
  const worktreePath = join(worktreeRoot, `merge-${safePathSegment(branchName)}`)
  mkdirSync(worktreeRoot, { recursive: true })
  if (existsSync(worktreePath)) return worktreePath
  const result = await runCommand('git', ['-C', basePath, 'worktree', 'add', '--detach', worktreePath, `origin/${baseBranch}`], {
    timeoutMs: 120_000,
    signal,
    onOutput: ({ stream, chunk }) => {
      const target = stream === 'stderr' ? process.stderr : process.stdout
      target.write(chunk)
    },
  })
  if (!result.ok) {
    console.warn(`[Daemon] Could not create review merge worktree for ${branchName}; merge will be skipped safely.`)
    return null
  }
  return worktreePath
}

export function registerDaemon(program: Command): void {
  const daemon = program.command('daemon').description('manage local AI task daemons')

  registerDaemonPipeline(daemon)

  daemon
    .command('tools')
    .alias('detect')
    .description('list detected AI agent CLI tools and their availability status')
    .option('--tools <list>', 'comma-separated list of AI tools to inspect (defaults to all known tools)')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const toolList = opts.tools
        ? opts.tools.split(',').map((t: string) => t.trim()).filter(Boolean)
        : KNOWN_AI_TOOLS
      const reports = await inspectTools(toolList)
      if (opts.json) return printJson(reports)

      const rows = reports.map((r) => ({
        tool: r.tool,
        installed: r.installed ? 'yes' : 'no',
        status: r.status,
        path: r.path ?? '-',
        details: r.reason ?? '-',
      }))
      printTable(rows, ['tool', 'installed', 'status', 'path', 'details'])

      const runnable = reports.filter((r) => r.status === 'available').map((r) => r.tool)
      console.log(`\nAvailable tools: ${runnable.join(', ') || 'none'}`)
    })

  daemon
    .command('start')
    .description('start the local AI task runner daemon')
    .option('--tools <list>', 'comma-separated list of available AI tools (e.g. codex,claude,agy)')
    .option('--capabilities <list>', 'comma-separated auxiliary capabilities advertised for task matching')
    .option('--project <id>', 'restrict task polling to a specific project')
    .option('--mode <mode>', 'override server-recommended mode (polling|sse)')
    .option('--id <uuid>', 'executor instance ID (defaults to a unique process ID)')
    .option('--workers <n>', 'number of parallel task workers (default: 1)')
    .option('--model <tier:model>', 'model mapping for a tier; repeat for fast, standard, strong', collectModelMapping, [])
    .option('--think <tier:effort>', `Codex reasoning effort mapping for a tier; repeat for fast, standard, strong (${CODEX_REASONING_EFFORTS.join('|')})`, collectModelMapping, [])
    .option('--prompt <text>', 'extra local prompt text to append to each spawned worker; repeatable', collectRepeatedOption, [])
    .option('--prompt-file <path>', 'read extra local worker prompt text from a file; repeatable', collectRepeatedOption, [])
    .option('--once', 'process at most one requirement lane for the daemon (worker 0 only), then exit')
    .action(async (opts) => {
      const cliConfig = loadConfig()
      const modelMappings = parseModelMappings(opts.model)
      const thinkMappings = parseThinkMappings(opts.think)
      const extraWorkerPrompt = loadExtraWorkerPrompt({ prompt: opts.prompt, promptFile: opts.promptFile })
      const supportedModelTiers = Object.keys(modelMappings)

      const identity = resolveDaemonProcessIdentity('executor', opts.id, cliConfig)
      const daemonId = identity.instanceId
      const actorId = identity.actorId

      let tools: string[] = []
      if (opts.tools) {
        tools = opts.tools.split(',').map((t: string) => t.trim())
      } else {
        tools = detectTools()
        console.log(`[Daemon] Auto-detected AI CLI tools in PATH: ${tools.join(', ') || 'none'}`)
      }

      const executorPreflight = await preflightExecutorTools(tools)
      for (const unavailable of executorPreflight.unavailable) {
        console.warn(`[Daemon] AI executor '${unavailable.tool}' is unavailable: ${unavailable.reason}`)
      }
      tools = executorPreflight.runnable
      if (tools.length === 0) {
        throw new Error('No runnable AI executor is available; daemon stopped before registration or work acquisition.')
      }
      const auxiliaryCapabilities = opts.capabilities
        ? String(opts.capabilities).split(',').map((value) => value.trim()).filter(Boolean)
        : []

      process.env.TW_ACTOR_ID = actorId
      const daemonRequest = <T>(method: string, path: string, body?: unknown) =>
        request<T>(method, path, body, { actorId, actorType: 'agent', omitAuth: true })
      const daemonGet = <T>(path: string) => daemonRequest<T>('GET', path)
      const daemonPost = <T>(path: string, body: unknown) => daemonRequest<T>('POST', path, body)
      const daemonPatch = <T>(path: string, body: unknown) => daemonRequest<T>('PATCH', path, body)

      const host = hostname()
      const numWorkers = Math.max(1, parseInt(opts.workers ?? '1', 10) || 1)
      console.log(`[Daemon] Starting executor... Instance: ${daemonId}, Actor: ${actorId}, Host: ${host}, Workers: ${numWorkers}`)

      // 1. Register with API and negotiate config
      const registerRes = await daemonPost<any>('/api/v1/daemons/register', {
        id: daemonId,
        name: `daemon-${host}`,
        role: 'executor',
        capabilities: [
          ...tools,
          ...tools.map((tool) => `executor:${tool}`),
          ...auxiliaryCapabilities,
          ...supportedModelTiers.map((tier) => `model-tier:${tier}`),
        ],
        host,
        processStartedAt: identity.processStartedAt,
        workerCapacity: numWorkers,
      })

      const serverConfig: DaemonConfig = registerRes.config ?? {
        mode: 'polling',
        pollingIntervalMs: 10_000,
        pollingBackoffMax: 60_000,
      }

      const effectiveMode = opts.mode ?? serverConfig.mode
      console.log(`[Daemon] Registered. Mode: ${effectiveMode}, interval: ${serverConfig.pollingIntervalMs}ms, backoff max: ${serverConfig.pollingBackoffMax}ms`)

      // 2. Per-worker state
      const workers: WorkerState[] = Array.from({ length: numWorkers }, (_, i) => ({
        index: i,
        currentRequirementId: null,
        currentExecutionSliceId: null,
        currentTaskId: null,
        requirementTitle: null,
        executionSliceTitle: null,
        taskTitle: null,
        modelTier: null,
        model: null,
        reasoningEffort: null,
        runId: null,
        leaseGeneration: null,
        leaseHealthy: null,
        leaseHeartbeatFailures: 0,
        lastLeaseError: null,
        branchName: null,
        worktreePath: null,
        startedAt: null,
        activeProcess: false,
        pollTimer: null,
        currentInterval: serverConfig.pollingIntervalMs,
        polling: false,
        lastEligibilitySummary: null,
      }))
      let sseCleanup: (() => void) | null = null
      let stopping = false
      const lifecycle = new DaemonLifecycle()

      // Reports current status + all active task IDs to the server
      const reportDaemonStatus = async (status: 'idle' | 'busy' | 'offline') => {
        const activeTaskIds = workers.map(w => w.currentTaskId).filter((id): id is string => id !== null)
        const activeWorkerStates = workers.map(w => ({
          index: w.index,
          status: lifecycle.isDraining && w.activeProcess ? 'stopping' : w.activeProcess ? 'running' : 'idle',
          requirementId: w.currentRequirementId,
          requirementTitle: w.requirementTitle,
          executionSliceId: w.currentExecutionSliceId,
          executionSliceTitle: w.executionSliceTitle,
          modelTier: w.modelTier,
          model: w.model,
          reasoningEffort: w.reasoningEffort,
          runId: w.runId,
          leaseGeneration: w.leaseGeneration,
          leaseHealthy: w.leaseHealthy,
          leaseHeartbeatFailures: w.leaseHeartbeatFailures,
          lastLeaseError: w.lastLeaseError,
          taskId: w.currentTaskId,
          taskTitle: w.taskTitle,
          branchName: w.branchName,
          worktreePath: w.worktreePath,
          startedAt: w.startedAt,
          updatedAt: new Date().toISOString(),
        }))
        try {
          await daemonPost(`/api/v1/daemons/${daemonId}/status`, { status, activeTaskIds, activeWorkerStates })
        } catch (err) {
          console.error('[Daemon] Failed to report status:', err instanceof Error ? err.message : String(err))
        }
      }

      const leaseSupervisor = new LeaseSupervisor({
        heartbeatProcess: () => daemonPost(`/api/v1/daemons/${daemonId}/heartbeat`, {}),
        heartbeatLease: (lease) => daemonPost(`/api/v1/requirements/${lease.requirementId}/heartbeat`, {
          extendMinutes: 2,
          daemonId,
          leaseGeneration: lease.generation,
        }),
        onHealthChange: (snapshot) => {
          const worker = workers[Number(snapshot.key)]
          if (!worker) return
          applyLeaseSnapshot(worker, snapshot)
          if (!snapshot.healthy) {
            console.error(`[Daemon] Worker ${worker.index} lease became unhealthy: ${snapshot.lastError ?? 'unknown heartbeat failure'}`)
          }
          void reportDaemonStatus(workers.some((candidate) => candidate.activeProcess) ? 'busy' : 'idle')
        },
        onProcessError: (error) => {
          if (error) console.error(`[Daemon] Process heartbeat failed: ${error}`)
        },
      })
      leaseSupervisor.start()

      const stopDaemon = async (status: 'idle' | 'busy' | 'offline', exitCode: number) => {
        if (stopping) return
        stopping = true
        leaseSupervisor.stop()
        for (const w of workers) {
          if (w.pollTimer) clearTimeout(w.pollTimer)
        }
        if (sseCleanup) sseCleanup()
        await reportDaemonStatus(status)
        if (lifecycle.activeOperations === 0 && lifecycle.phase === 'running') lifecycle.stop()
        process.exitCode = exitCode
      }

      // Per-worker helpers
      const resetBackoff = (w: WorkerState) => { w.currentInterval = serverConfig.pollingIntervalMs }
      const backoff = (w: WorkerState) => {
        w.currentInterval = Math.min(w.currentInterval * 2, serverConfig.pollingBackoffMax)
      }

      const schedulePoll = (w: WorkerState) => {
        if (stopping || lifecycle.isDraining || w.activeProcess) return
        if (w.pollTimer) clearTimeout(w.pollTimer)
        w.pollTimer = setTimeout(() => poll(w), w.currentInterval)
      }

      const runAgent = async (w: WorkerState, lane: RequirementLane, signal: AbortSignal) => {
        const { requirement, executionSlice, task, tasks: laneTasks } = lane
        const leaseFence = { daemonId, leaseGeneration: lane.leaseGeneration }
        const assertLease = () => leaseSupervisor.assertHealthy(String(w.index))
        const assertActive = () => {
          throwIfCancelled(signal)
          assertLease()
        }
        const fencedPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        const recoveryPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertLease()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        const reportProgress = async (body: Record<string, unknown>) => {
          if (!lane.runId) return undefined
          assertLease()
          return daemonPost(`/api/v1/daemons/${daemonId}/progress`, {
            runId: lane.runId,
            workerIndex: w.index,
            requirementId: requirement.id,
            executionSliceId: executionSlice?.id ?? null,
            leaseGeneration: lane.leaseGeneration,
            ...body,
          })
        }
        const toolCmd = selectExecutorTool(tools, task.tags || [], lane.executorTool)
        if (!toolCmd) {
          throw new Error(`No configured AI executor satisfies task ${task.id}`)
        }
        const modelTier = executionSlice?.modelTier ?? requirement.modelTier ?? 'standard'
        const selectedModel = modelMappings[modelTier]
        const selectedReasoningEffort = thinkMappings[modelTier]
        console.log(`[Daemon] Worker ${w.index} resolving requirement "${requirement.title}"${executionSlice ? ` slice "${executionSlice.title}"` : ''} using tool: '${toolCmd}'${selectedModel ? ` model: '${selectedModel}'` : ''}${selectedReasoningEffort && toolCmd === 'codex' ? ` think: '${selectedReasoningEffort}'` : ''}`)

        let branchName: string = requirement?.branchName || task.branchName || ''
        if (!branchName && requirement) {
          const slug = (requirement.title as string)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40)
          branchName = `req/${(requirement.id as string).slice(0, 8)}-${slug}`
          try {
            await fencedPatch(`/api/v1/requirements/${requirement.id}`, { branchName })
            console.log(`[Daemon] Worker ${w.index} auto-generated branch name '${branchName}' and saved to requirement.`)
          } catch (err) {
            console.warn(`[Daemon] Worker ${w.index} could not save branch name to requirement:`, err instanceof Error ? err.message : String(err))
          }
        }

        let workspace: Awaited<ReturnType<typeof provisionCompositeWorkspace>>
        try {
          workspace = await provisionCompositeWorkspace({
            config: cliConfig,
            requirement: { id: requirement.id, title: requirement.title, branchName },
            executionSlice: executionSlice ? { id: executionSlice.id, orderIndex: executionSlice.orderIndex } : null,
            entries: lane.repositories,
            updateDelivery: (linkId, fields) => fencedPatch(`/api/v1/requirement-repositories/${linkId}/delivery`, fields),
            signal,
          })
        } catch (err) {
          const summary = err instanceof Error ? err.message : String(err)
          if (executionSlice?.id) {
            await recoveryPatch(`/api/v1/execution-slices/${executionSlice.id}`, {
              status: 'todo', resultSummary: `Repository workspace provisioning failed: ${summary}`,
            }).catch(() => undefined)
          }
          await recoveryPatch(`/api/v1/tasks/${task.id}/status`, {
            status: 'todo', reason: `Repository workspace provisioning failed: ${summary}`,
          }).catch(() => undefined)
          await daemonPost(`/api/v1/requirements/${requirement.id}/release`, {
            reason: `repository workspace provisioning failed on worker ${w.index}`,
            ...leaseFence,
          }).catch(() => undefined)
          leaseSupervisor.unregister(String(w.index))
          w.runId = null
          w.leaseGeneration = null
          w.leaseHealthy = null
          w.leaseHeartbeatFailures = 0
          w.lastLeaseError = null
          w.activeProcess = false
          throw err
        }
        const workspacePath = workspace.rootPath
        console.log(`[Daemon] Worker ${w.index} composite workspace: ${workspacePath}`)
        const initialWorkspaceSnapshot = await inspectCompositeWorkspace(workspace, {
          config: cliConfig,
          entries: lane.repositories,
          signal,
        })
        await reportProgress({
          currentTaskId: task.id,
          phase: 'executing',
          message: initialWorkspaceSnapshot.workspaceState === 'dirty'
            ? 'Resuming preserved uncommitted workspace changes'
            : 'Worker workspace is ready',
          workspaceState: initialWorkspaceSnapshot.workspaceState,
          recoveryDisposition: initialWorkspaceSnapshot.workspaceState === 'dirty' ? 'resume' : 'none',
          pendingDiffSummary: initialWorkspaceSnapshot.pendingDiffSummary,
        }).catch((err) => {
          console.warn(`[Daemon] Worker ${w.index} could not report workspace progress:`, err instanceof Error ? err.message : String(err))
        })

        let bootstrapText = ''
        try {
          const bs = await get<any>('/api/v1/context/bootstrap')
          bootstrapText = `Task Weaver Platform Bootstrap Info:
- Description: ${bs.description}
- Usage: ${bs.usage}
- Available Commands:
${(bs.commands || []).map((c: any) => `  * ${c.name}: ${c.description}`).join('\n')}
`
        } catch {
          bootstrapText = `Task Weaver Platform: Manage projects, requirements, tasks, documents, and search using 'tw' commands (e.g. tw task list, tw task status, tw doc get).`
        }

        const workspaceSection = `Composite Repository Workspace:
- Local path: ${workspacePath}
- Frozen manifest: ${workspace.manifestPath}
- Repository worktrees:
${workspace.repositories.length > 0
  ? workspace.repositories.map((repository) => `  * ${repository.canonicalKey}: ${repository.relativePath} (branch ${repository.workingBranch})`).join('\n')
  : '  * None. This is a repository-free Requirement slice.'}
- The 'tw' CLI is available and pre-configured with the correct API URL and key. Use it directly (no setup needed).
- Run: cd ${workspacePath} before any file edits or shell commands.
- Work only inside the listed repository directories. Do not add repositories or change branches during this slice.
- Do not run authenticated Git network operations; the daemon owns fetch, push, and forge delivery.`

        const workspaceRecoverySection = `Workspace Recovery State:
- State: ${initialWorkspaceSnapshot.workspaceState}
- Existing changes: ${initialWorkspaceSnapshot.pendingDiffSummary ?? 'none'}
- Dirty changes are intentionally preserved for this run. Continue from them instead of resetting or discarding them.`

        const taskRoadmap = laneTasks.map((t: any, index: number) =>
          `${index + 1}. [${t.status}] ${t.title} (${t.id})${t.description ? `\n   ${t.description}` : ''}`,
        ).join('\n')

        const gitWorkflowSection = `Daemon-Owned Multi-Repository Finalization:
- The daemon prepared one isolated worktree per frozen Requirement repository and owns all authenticated Git/forge operations.
- Do not run git checkout or mutate the repository manifest.
- Do not commit, push, create a PR, or change the requirement final status yourself.
- Leave code changes in their repository worktrees. When all tasks are terminal, the daemon independently commits, pushes, and creates/discovers PRs according to each provider's capabilities.
- Successful repository outcomes are preserved when another repository fails; retries start only from failed delivery state.
- If this slice is complete but other requirement tasks remain, the daemon keeps the requirement lane available for the next slice.`

        const sliceSection = executionSlice
          ? `Execution Slice:
- Slice ID: ${executionSlice.id}
- Title: ${executionSlice.title}
- Model Tier: ${modelTier}
- Description: ${executionSlice.description || 'No description provided.'}

This Codex session is scoped to this execution slice. Complete only the tasks listed in the slice roadmap unless a small prerequisite update is required.`
          : `Execution Slice:
- No execution slice is planned for this requirement yet.
- This Codex session may process the requirement lane roadmap below.`

        const reasoningSection = toolCmd === 'codex' && selectedReasoningEffort
          ? `- Codex Reasoning Effort: ${selectedReasoningEffort}\n`
          : ''
        const extraWorkerPromptSection = formatExtraWorkerPromptSection(extraWorkerPrompt)

        const prompt = `You are an autonomous AI Agent triggered by Task Weaver to resolve part of a requirement lane:

Requirement Details:
- Project ID: ${requirement.projectId}
- Requirement ID: ${requirement.id}
- Title: ${requirement.title}
- Description: ${requirement.description || 'No description provided.'}
- Branch: ${branchName}
- Model Tier: ${modelTier}
${reasoningSection}

${sliceSection}

Initial Active Task:
- Task ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description || 'No description provided.'}

Current Slice Task Roadmap:
${taskRoadmap}

${workspaceSection}

${workspaceRecoverySection}

${bootstrapText}

${extraWorkerPromptSection}

${gitWorkflowSection}

IMPORTANT REQUIREMENTS & PROTOCOL:
1. The requirement is already claimed by the daemon. Do NOT claim or release it.
2. Process tasks in the current slice sequentially. Start with ${task.id}, then continue with remaining unblocked todo tasks in this slice.
3. Before working a task, set it to in_progress if needed. When finished, set it to done with a reason. Use in_review when human judgment is needed.
4. Use the 'tw' CLI commands to fetch context, list requirements, fetch documents, search, and update progress.
5. Follow the Daemon-Owned Git Finalization section above after completing code changes for the requirement.
6. If this slice is complete, leave a concise summary in task comments or requirement notes as useful context for the next slice.
7. Do not mark requirement ${requirement.id} done. The daemon will move it to in_review after branch publication when all tasks are terminal.
`

        w.currentTaskId = task.id
        w.currentRequirementId = requirement.id
        w.currentExecutionSliceId = executionSlice?.id ?? null
        w.requirementTitle = requirement.title
        w.executionSliceTitle = executionSlice?.title ?? null
        w.taskTitle = task.title
        w.modelTier = modelTier
        w.model = selectedModel ?? null
        w.reasoningEffort = toolCmd === 'codex' ? selectedReasoningEffort ?? null : null
        w.branchName = branchName
        w.worktreePath = workspacePath
        w.startedAt = new Date().toISOString()
        await reportDaemonStatus('busy')

        const configuredAgentTimeout = Number(process.env.TW_DAEMON_AGENT_TIMEOUT_MS)
        const workspaceQuarantined = initialWorkspaceSnapshot.workspaceState === 'conflicted'
          || initialWorkspaceSnapshot.workspaceState === 'missing'
        if (workspaceQuarantined) {
          console.warn(`[Daemon] Worker ${w.index} quarantined workspace in state '${initialWorkspaceSnapshot.workspaceState}' before agent launch.`)
        }
        const childResult = workspaceQuarantined ? {
          ok: false,
          status: 1,
          stdout: '',
          stderr: `workspace_${initialWorkspaceSnapshot.workspaceState}`,
          command: 'workspace-preflight',
          signal: null,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          durationMs: 0,
        } : await runCommand(
          toolCmd,
          buildArgv(toolCmd, prompt, workspacePath, selectedModel, selectedReasoningEffort),
          {
            cwd: workspacePath,
            env: buildAiEnvironment(process.env, {
              CI: process.env.CI ?? '1',
              NO_COLOR: '1',
              TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color',
              TW_ACTOR_ID: actorId,
              TW_API_KEY: '',
              TW_DAEMON_ID: daemonId,
              TW_REQUIREMENT_LEASE_GENERATION: String(lane.leaseGeneration),
              ...(lane.runId ? { TW_DAEMON_RUN_ID: lane.runId } : {}),
            }),
            timeoutMs: Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0
              ? configuredAgentTimeout
              : 60 * 60_000,
            killGraceMs: 5_000,
            maxOutputBytes: 20 * 1024 * 1024,
            signal,
            redact: redactTrustedOutput,
            onOutput: ({ stream, chunk }) => {
              for (const line of chunk.split(/\r?\n/)) {
                if (line.trim()) console.log(`[Daemon] Worker ${w.index} ${stream}: ${line}`)
              }
            },
          },
        )
        const cancelReason = cancellationReason(signal)
        const outcome = childResult.timedOut
          ? `timed out after ${childResult.durationMs}ms`
          : childResult.cancelled
            ? `cancelled (${cancelReason ?? 'operation cancelled'})`
            : `exited with code ${childResult.status ?? 'unknown'}`
        console.log(`[Daemon] Worker ${w.index} AI Agent ${outcome}`)
        let recoveryWorkspaceSnapshot: Awaited<ReturnType<typeof inspectCompositeWorkspace>> | null = null
        const getRecoveryWorkspaceSnapshot = async () => {
          recoveryWorkspaceSnapshot ??= await inspectCompositeWorkspace(workspace, {
            config: cliConfig,
            entries: lane.repositories,
          }).catch((err) => ({
            workspaceState: 'unknown' as const,
            pendingDiffSummary: `Workspace inspection failed: ${err instanceof Error ? err.message : String(err)}`,
          }))
          return recoveryWorkspaceSnapshot
        }
        const taskId = w.currentTaskId
        const requirementId = w.currentRequirementId
        const executionSliceId = w.currentExecutionSliceId
        w.currentTaskId = null
        w.currentRequirementId = null
        w.currentExecutionSliceId = null
        w.requirementTitle = null
        w.executionSliceTitle = null
        w.taskTitle = null
        w.modelTier = null
        w.model = null
        w.reasoningEffort = null
        w.branchName = null
        w.worktreePath = null
        w.startedAt = null
        w.activeProcess = false

        let workerSucceeded = childResult.ok
        let completionOutcome = outcome
        const recoverForRetry = async (reason: string, deliveryFailureCode?: string) => {
          const workspaceSnapshot = await getRecoveryWorkspaceSnapshot()
          let reconciled = false
          if (lane.runId) {
            await daemonPost(`/api/v1/daemons/${daemonId}/reconcile`, {
              runId: lane.runId,
              workerIndex: w.index,
              requirementId,
              executionSliceId,
              leaseGeneration: lane.leaseGeneration,
              reason,
              workspaceState: workspaceSnapshot.workspaceState,
              pendingDiffSummary: workspaceSnapshot.pendingDiffSummary,
              sliceSummary: `${reason}; active work was reconciled from durable progress.`,
              handoffSummary: workspaceSnapshot.workspaceState === 'dirty'
                ? 'Resume the preserved workspace changes before starting new work.'
                : workspaceSnapshot.workspaceState === 'conflicted' || workspaceSnapshot.workspaceState === 'missing'
                  ? 'Workspace was quarantined and requires operator review.'
                  : 'Retry only tasks that were active when the worker stopped.',
            }).then(() => {
              reconciled = true
            }).catch((err) => {
              console.error(`[Daemon] Worker ${w.index} durable recovery failed:`, err instanceof Error ? err.message : String(err))
            })
          }
          if (!reconciled) {
            if (executionSliceId) {
              await recoveryPatch(`/api/v1/execution-slices/${executionSliceId}`, {
                status: 'todo',
                resultSummary: `${reason}; slice returned to todo for retry.`,
              }).catch((err) => {
                console.error(`[Daemon] Worker ${w.index} failed to recover execution slice:`, err instanceof Error ? err.message : String(err))
              })
            }
            if (taskId) {
              await recoveryPatch(`/api/v1/tasks/${taskId}/status`, {
                status: 'todo',
                reason: `${reason} — reverting active task to todo for retry`,
              }).catch((err) => {
                console.error(`[Daemon] Worker ${w.index} failed to recover task:`, err instanceof Error ? err.message : String(err))
              })
            }
          }
          if (taskId && deliveryFailureCode) {
            await daemonPost(`/api/v1/tasks/${taskId}/comments`, {
              content: `Daemon recovery: ${reason}. Active work was returned to todo for retry or quarantined for review from durable progress; unfinished delivery attempts remain retryable.`,
            }).catch(() => undefined)
          }
          if (deliveryFailureCode) {
            for (const entry of lane.repositories) {
              await recoveryPatch(`/api/v1/requirement-repositories/${entry.link.id}/delivery`, {
                deliveryStatus: 'failed',
                failureCode: deliveryFailureCode,
                failureSummary: reason,
                lastAttemptAt: new Date().toISOString(),
              }).catch(() => undefined)
            }
          }
        }

        if (requirementId) {
          if (!childResult.ok) {
            await recoverForRetry(
              `Daemon requirement-lane agent ${outcome}`,
              childResult.cancelled ? 'agent_cancelled' : childResult.timedOut ? 'agent_timeout' : undefined,
            )
          } else {
            try {
              const req = await daemonGet<any>(`/api/v1/requirements/${requirementId}`)
              const reqTasks = Array.isArray(req.tasks) ? req.tasks : []
              let sliceSummary: string | null = null
              let openSliceTasks: any[] = []
              if (executionSliceId) {
                const slices = Array.isArray(req.executionSlices) ? req.executionSlices : []
                const activeSlice = slices.find((slice: any) => slice.id === executionSliceId)
                const sliceTasks = Array.isArray(activeSlice?.tasks) ? activeSlice.tasks : []
                openSliceTasks = sliceTasks.filter((candidate: any) => !['done', 'cancelled'].includes(candidate.status))
                sliceSummary = openSliceTasks.length === 0
                  ? 'Daemon slice agent exited cleanly and all slice tasks are terminal.'
                  : 'Daemon slice agent exited cleanly but some slice tasks remain open; needs review.'
              }

              const openTasks = reqTasks.filter((candidate: any) => !['done', 'cancelled'].includes(candidate.status))
              if (openTasks.length === 0) {
                const delivery = await finalizeCompositeWorkspace({
                  config: cliConfig,
                  workspace,
                  entries: lane.repositories,
                  requirement: { title: req.title },
                  updateDelivery: (linkId, fields) => fencedPatch(`/api/v1/requirement-repositories/${linkId}/delivery`, fields),
                  signal,
                })
                const failed = delivery.filter((item) => item.result.deliveryStatus === 'failed')
                const finalizationSummary = delivery.length === 0
                  ? 'Repository-free Requirement; no Git delivery was required.'
                  : `Repository delivery finished for ${delivery.length} repositories; ${failed.length} failed and remain independently retryable.`
                if (taskId ?? reqTasks[0]?.id) {
                  await daemonPost(`/api/v1/tasks/${taskId ?? reqTasks[0].id}/comments`, { content: finalizationSummary })
                }
                if (executionSliceId) {
                  await fencedPatch(`/api/v1/execution-slices/${executionSliceId}`, {
                    status: openSliceTasks.length === 0 ? 'done' : 'in_review',
                    resultSummary: `${sliceSummary ?? 'Daemon requirement agent exited cleanly.'}\n\n${finalizationSummary}`,
                  })
                }
                await fencedPatch(`/api/v1/requirements/${requirementId}`, { status: 'in_review' })
                console.log(`[Daemon] Worker ${w.index} requirement ${requirementId} finalized across ${delivery.length} repositories.`)
              } else {
                if (executionSliceId) {
                  await fencedPatch(`/api/v1/execution-slices/${executionSliceId}`, {
                    status: openSliceTasks.length === 0 ? 'done' : 'in_review',
                    resultSummary: sliceSummary,
                  })
                }
                if (taskId) {
                  const active = reqTasks.find((candidate: any) => candidate.id === taskId)
                  if (active?.status === 'todo' || active?.status === 'in_progress') {
                    await fencedPatch(`/api/v1/tasks/${taskId}/status`, {
                      status: 'in_review',
                      reason: 'Daemon requirement-lane agent exited cleanly but did not finalize active task status — needs review',
                    })
                    console.log(`[Daemon] Worker ${w.index} task ${taskId} routed to 'in_review' (agent did not finalize status).`)
                  }
                }
              }
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err)
              completionOutcome = signal.aborted
                ? `finalization cancelled during drain (${cancellationReason(signal) ?? 'operation cancelled'})`
                : `finalization failed (${detail})`
              workerSucceeded = false
              console.warn(`[Daemon] Worker ${w.index} could not verify/finalize requirement lane: ${detail}`)
              await recoverForRetry(`Daemon ${completionOutcome}`, signal.aborted ? 'finalization_cancelled' : 'finalization_failed')
            }
          }

          try {
            await daemonPost(`/api/v1/requirements/${requirementId}/release`, {
              reason: `daemon worker ${w.index} ${completionOutcome}`,
              ...leaseFence,
            })
          } catch (err) {
            console.warn(`[Daemon] Worker ${w.index} requirement release skipped:`, err instanceof Error ? err.message : String(err))
          }
          leaseSupervisor.unregister(String(w.index))
          w.runId = null
          w.leaseGeneration = null
          w.leaseHealthy = null
          w.leaseHeartbeatFailures = 0
          w.lastLeaseError = null
        }

        const allIdle = workers.every((candidate) => !candidate.activeProcess)
        await reportDaemonStatus(allIdle ? 'idle' : 'busy')
        if (allIdle) console.log('[Daemon] All workers idle. Ready for next tasks.')
        if (opts.once && allIdle) {
          await stopDaemon('idle', workerSucceeded ? 0 : 1)
          return
        }

        resetBackoff(w)
        schedulePoll(w)
      }

      // Per-worker poll
      const poll = async (w: WorkerState) => {
        if (!shouldExecutorWorkerPoll(Boolean(opts.once), w.index)) return
        if (stopping || lifecycle.isDraining || w.polling || w.activeProcess) return
        w.polling = true
        let stopAfterIdlePoll = false
        try {
          if (w.index === 0) {
            try {
              await daemonPost('/api/v1/schedules/acquire-due', {
                projectId: opts.project,
                limit: Math.max(10, numWorkers * 5),
              })
            } catch (err) {
              console.warn('[Daemon] Schedule acquisition skipped:', err instanceof Error ? err.message : String(err))
            }
          }

          const res = await daemonPost<{ requirement: any | null; executionSlice?: any | null; task: any | null; tasks: any[]; repositories: RequirementRepositoryEntry[]; executorTool?: string | null; eligibility?: SchedulerEligibilityDiagnostics; leaseGeneration?: number; runId?: string }>(`/api/v1/daemons/${daemonId}/apply-requirement`, {
            projectId: opts.project,
            workerIndex: w.index,
            modelTiers: supportedModelTiers.length > 0 ? supportedModelTiers : undefined,
            includeDiagnostics: true,
          })
          if (res && res.requirement && res.task && res.leaseGeneration) {
            if (lifecycle.isDraining) {
              await daemonPost(`/api/v1/requirements/${res.requirement.id}/release`, {
                reason: 'daemon entered drain mode during acquisition',
                daemonId,
                leaseGeneration: res.leaseGeneration,
              }).catch(() => undefined)
              return
            }
            const operation = lifecycle.start(String(w.index))
            const eligibilitySummary = res.eligibility
              ? `; ${formatEligibilityDiagnostics(res.eligibility)}`
              : ''
            console.log(`[Daemon] Worker ${w.index} acquired requirement: "${res.requirement.title}" (ID: ${res.requirement.id})${res.executionSlice ? ` slice: "${res.executionSlice.title}"` : ''}${eligibilitySummary}`)
            resetBackoff(w)
            w.lastEligibilitySummary = null
            w.activeProcess = true
            w.runId = res.runId ?? null
            w.leaseGeneration = res.leaseGeneration
            w.leaseHealthy = true
            w.leaseHeartbeatFailures = 0
            w.lastLeaseError = null
            leaseSupervisor.register({
              key: String(w.index),
              requirementId: res.requirement.id,
              generation: res.leaseGeneration,
            })
            try {
              await runAgent(w, {
                requirement: res.requirement,
                executionSlice: res.executionSlice,
                task: res.task,
                tasks: res.tasks || [],
                repositories: normalizeRequirementRepositoryEntries(res.repositories || []),
                executorTool: res.executorTool,
                leaseGeneration: res.leaseGeneration,
                runId: res.runId,
              }, operation.signal)
            } finally {
              operation.complete()
            }
            return
          }
          if (res?.eligibility) {
            const summary = formatEligibilityDiagnostics(res.eligibility)
            if (summary !== w.lastEligibilitySummary) {
              console.log(`[Daemon] Worker ${w.index} idle: ${summary}`)
              w.lastEligibilitySummary = summary
            }
          }
          backoff(w)
          if (opts.once) stopAfterIdlePoll = true
        } catch (err) {
          console.error(`[Daemon] Worker ${w.index} requirement polling failed:`, err instanceof Error ? err.message : String(err))
          backoff(w)
        } finally {
          w.polling = false
        }
        if (stopAfterIdlePoll) {
          await stopDaemon('idle', 0)
          return
        }
        schedulePoll(w)
      }

      // SSE mode with auto-fallback to polling
      const startSSE = () => {
        const ssePath = serverConfig.sseEndpoint || '/api/v1/daemons/events'
        const sseUrl = `${cliConfig.apiUrl}${ssePath}${ssePath.includes('?') ? '&' : '?'}role=executor`
        console.log(`[Daemon] Connecting to SSE: ${sseUrl}`)

        const headers: Record<string, string> = { 'X-Actor-Type': 'agent', 'X-Actor-Id': daemonId }
        if (cliConfig.apiKey) headers['Authorization'] = `Bearer ${cliConfig.apiKey}`

        let aborted = false
        const controller = new AbortController()

        const connect = async () => {
          try {
            const res = await fetch(sseUrl, { headers, signal: controller.signal })
            if (!res.ok || !res.body) {
              throw new Error(`SSE connection failed: HTTP ${res.status}`)
            }

            console.log('[Daemon] SSE connected. Waiting for task notifications...')
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            while (!aborted) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                if (
                  line.startsWith('event: task_created') ||
                  line.startsWith('event: task_released') ||
                  line.startsWith('event: requirement_created') ||
                  line.startsWith('event: requirement_released') ||
                  line.startsWith('event: repository_retry_requested')
                ) {
                  for (const w of workers) {
                    if (!w.activeProcess) poll(w)
                  }
                }
              }
            }
          } catch (err) {
            if (aborted) return
            console.warn('[Daemon] SSE disconnected:', err instanceof Error ? err.message : String(err))
          }

          // Reconnect or fallback
          if (!aborted) {
            console.log('[Daemon] SSE lost, falling back to polling. Retrying SSE in 30s...')
            for (const w of workers) schedulePoll(w)
            setTimeout(() => { if (!aborted) connect() }, 30_000)
          }
        }

        connect()

        return () => {
          aborted = true
          controller.abort()
        }
      }

      // Start all workers
      if (effectiveMode === 'sse') {
        sseCleanup = startSSE()
        for (const w of workers) poll(w)
      } else {
        for (const w of workers) poll(w)
      }

      const drainDaemon = async (reason: 'SIGINT' | 'SIGTERM') => {
        if (stopping) return
        stopping = true
        console.log(`\n[Daemon] ${reason} received; entering drain mode...`)
        for (const w of workers) {
          if (w.pollTimer) clearTimeout(w.pollTimer)
        }
        if (sseCleanup) sseCleanup()
        const drained = lifecycle.drain(reason)
        await reportDaemonStatus(lifecycle.activeOperations > 0 ? 'busy' : 'offline')
        await drained
        leaseSupervisor.stop()
        await reportDaemonStatus('offline')
        process.exitCode = 0
      }

      process.once('SIGINT', () => { void drainDaemon('SIGINT') })
      process.once('SIGTERM', () => { void drainDaemon('SIGTERM') })
    })

  daemon
    .command('review')
    .description('review finalized requirement branches and mark approved branches ready to merge')
    .requiredOption('--project <id>', 'project ID to review')
    .option('--tools <list>', 'comma-separated review AI tools (default: auto-detect, prefers codex)')
    .option('--base <branch>', 'base branch to review against (default: main)', 'main')
    .option('--id <uuid>', 'reviewer instance ID (defaults to a unique process ID)')
    .option('--workers <n>', 'number of parallel review workers (default: 1)')
    .option('--model <tier:model>', 'model mapping for a tier; repeat for fast, standard, strong', collectModelMapping, [])
    .option('--think <tier:effort>', `Codex reasoning effort mapping for a tier; repeat for fast, standard, strong (${CODEX_REASONING_EFFORTS.join('|')})`, collectModelMapping, [])
    .option('--check <cmd>', 'shell check command to run before approval; repeatable', collectRepeatedOption, [])
    .option('--prompt <text>', 'extra local prompt text to append to each review worker; repeatable', collectRepeatedOption, [])
    .option('--prompt-file <path>', 'read extra local review prompt text from a file; repeatable', collectRepeatedOption, [])
    .option('--skip-ai-review', 'skip AI review and rely on configured checks')
    .option('--allow-unreviewed', 'UNSAFE: allow approval without checks, AI review, or external approval; audited')
    .option('--post-forge-summary', 'post the local review summary to the provider pull request')
    .option('--no-merge', 'deprecated; review daemon no longer merges')
    .option('--once', 'process at most one acquired requirement, then exit')
    .action(async (opts) => {
      const cliConfig = loadConfig()
      const modelMappings = parseModelMappings(opts.model)
      const thinkMappings = parseThinkMappings(opts.think)
      const extraWorkerPrompt = loadExtraWorkerPrompt({ prompt: opts.prompt, promptFile: opts.promptFile })
      const checks = (opts.check ?? []) as string[]
      const baseBranch = opts.base as string

      const identity = resolveDaemonProcessIdentity('reviewer', opts.id, cliConfig)
      const daemonId = identity.instanceId
      const actorId = identity.actorId

      process.env.TW_ACTOR_ID = actorId
      const daemonRequest = <T>(method: string, path: string, body?: unknown) =>
        request<T>(method, path, body, { actorId, actorType: 'agent', omitAuth: true })
      const daemonPost = <T>(path: string, body: unknown) => daemonRequest<T>('POST', path, body)
      const daemonPatch = <T>(path: string, body: unknown) => daemonRequest<T>('PATCH', path, body)
      const daemonPut = <T>(path: string, body: unknown) => daemonRequest<T>('PUT', path, body)

      let tools: string[]
      if (opts.tools) {
        tools = opts.tools.split(',').map((t: string) => t.trim()).filter(Boolean)
      } else {
        tools = detectTools()
        console.log(`[Daemon] Auto-detected review tools in PATH: ${tools.join(', ') || 'none'}`)
      }
      const reviewTool = opts.skipAiReview ? null : (tools.includes('codex') ? 'codex' : tools[0] ?? null)
      if (!reviewTool && !opts.skipAiReview) {
        console.warn('[Daemon] WARNING: No review AI tool detected; review daemon will rely on configured checks only.')
      }
      if (opts.allowUnreviewed) {
        console.warn('[Daemon] WARNING: Unsafe unreviewed approval bypass is enabled; every use will be audited.')
      }

      const host = hostname()
      const numWorkers = Math.max(1, parseInt(opts.workers ?? '1', 10) || 1)
      console.log(`[Daemon] Starting reviewer... Instance: ${daemonId}, Actor: ${actorId}, Host: ${host}, Workers: ${numWorkers}, Base: ${baseBranch}`)

      const reviewRegistration = await daemonPost<any>('/api/v1/daemons/register', {
        id: daemonId,
        name: `review-daemon-${host}`,
        role: 'reviewer',
        capabilities: ['review', ...tools],
        host,
        processStartedAt: identity.processStartedAt,
        workerCapacity: numWorkers,
      })
      const reviewDaemonConfig: DaemonConfig = reviewRegistration.config ?? {
        mode: 'polling',
        pollingIntervalMs: 15_000,
        pollingBackoffMax: 60_000,
      }

      const workers: ReviewWorkerState[] = Array.from({ length: numWorkers }, (_, index) => ({
        index,
        currentRequirementId: null,
        requirementTitle: null,
        branchName: null,
        worktreePath: null,
        startedAt: null,
        activeProcess: false,
        leaseGeneration: null,
        leaseHealthy: null,
        leaseHeartbeatFailures: 0,
        lastLeaseError: null,
      }))

      let stopping = false
      const lifecycle = new DaemonLifecycle()
      const intervalMs = Number(process.env.TW_DAEMON_REVIEW_POLL_INTERVAL_MS) || 15_000
      const pollTimers: Array<ReturnType<typeof setTimeout> | null> = Array.from({ length: numWorkers }, () => null)
      let retryWakeCleanup: (() => void) | null = null

      const reportDaemonStatus = async (status: 'idle' | 'busy' | 'offline') => {
        const activeWorkerStates = workers.map((w) => ({
          index: w.index,
          status: lifecycle.isDraining && w.activeProcess ? 'stopping' : w.activeProcess ? 'running' : 'idle',
          requirementId: w.currentRequirementId,
          requirementTitle: w.requirementTitle,
          taskId: null,
          taskTitle: null,
          branchName: w.branchName,
          worktreePath: w.worktreePath,
          startedAt: w.startedAt,
          leaseGeneration: w.leaseGeneration,
          leaseHealthy: w.leaseHealthy,
          leaseHeartbeatFailures: w.leaseHeartbeatFailures,
          lastLeaseError: w.lastLeaseError,
          updatedAt: new Date().toISOString(),
        }))
        try {
          await daemonPost(`/api/v1/daemons/${daemonId}/status`, {
            status,
            activeTaskIds: [],
            activeWorkerStates,
          })
        } catch (err) {
          console.error('[Daemon] Failed to report review daemon status:', err instanceof Error ? err.message : String(err))
        }
      }

      const leaseSupervisor = new LeaseSupervisor({
        heartbeatProcess: () => daemonPost(`/api/v1/daemons/${daemonId}/heartbeat`, {}),
        heartbeatLease: (lease) => daemonPost(`/api/v1/requirements/${lease.requirementId}/heartbeat`, {
          extendMinutes: 5,
          daemonId,
          leaseGeneration: lease.generation,
        }),
        onHealthChange: (snapshot) => {
          const worker = workers[Number(snapshot.key)]
          if (!worker) return
          applyLeaseSnapshot(worker, snapshot)
          if (!snapshot.healthy) {
            console.error(`[Daemon] Review worker ${worker.index} lease became unhealthy: ${snapshot.lastError ?? 'unknown heartbeat failure'}`)
          }
          void reportDaemonStatus(workers.some((candidate) => candidate.activeProcess) ? 'busy' : 'idle')
        },
        onProcessError: (error) => {
          if (error) console.error(`[Daemon] Review process heartbeat failed: ${error}`)
        },
      })
      leaseSupervisor.start()

      const stopReviewDaemon = async (status: 'idle' | 'busy' | 'offline', exitCode: number) => {
        if (stopping) return
        stopping = true
        retryWakeCleanup?.()
        leaseSupervisor.stop()
        for (const timer of pollTimers) {
          if (timer) clearTimeout(timer)
        }
        await reportDaemonStatus(status)
        if (lifecycle.activeOperations === 0 && lifecycle.phase === 'running') lifecycle.stop()
        process.exitCode = exitCode
      }

      const runAiReview = async (prompt: string, cwd: string, signal?: AbortSignal): Promise<ReviewDecision> => {
        if (!reviewTool) {
          return { approved: true, summary: 'AI review skipped.' }
        }
        const modelTier = 'strong'
        const child = await runCommand(
          reviewTool,
          buildArgv(reviewTool, prompt, cwd, modelMappings[modelTier], thinkMappings[modelTier]),
          {
            cwd,
            env: buildAiEnvironment(process.env, {
              CI: process.env.CI ?? '1',
              NO_COLOR: '1',
              TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color',
              TW_ACTOR_ID: actorId,
              TW_API_KEY: '',
            }),
            timeoutMs: 60 * 60_000,
            maxOutputBytes: 20 * 1024 * 1024,
            signal,
            redact: redactTrustedOutput,
            onOutput: ({ stream, chunk }) => {
              for (const line of chunk.split(/\r?\n/)) {
                if (line.trim()) console.log(`[Daemon] Review tool ${stream}: ${line}`)
              }
            },
          },
        )
        const output = [child.stdout, child.stderr].filter(Boolean).join('\n').trim()
        if (!child.ok) {
          return {
            approved: false,
            summary: `Review tool exited with code ${child.status ?? 'unknown'}${child.timedOut ? ' after timing out' : ''}${child.cancelled ? ' after cancellation' : ''}.\n${output}`,
          }
        }
        return parseReviewDecision(output)
      }

      const applyReviewCandidate = async (w: ReviewWorkerState) => {
        const lane = await daemonPost<{
          requirement: any | null
          tasks: any[]
          executionSlice?: any | null
          repositories: RequirementRepositoryEntry[]
          leaseGeneration?: number
        }>(
          `/api/v1/daemons/${daemonId}/apply-review`,
          {
            projectId: opts.project,
            workerIndex: w.index,
          },
        )
        return { ...lane, repositories: normalizeRequirementRepositoryEntries(lane.repositories || []) }
      }

      const resetWorker = (w: ReviewWorkerState) => {
        w.currentRequirementId = null
        w.requirementTitle = null
        w.branchName = null
        w.worktreePath = null
        w.startedAt = null
        w.activeProcess = false
        w.leaseGeneration = null
        w.leaseHealthy = null
        w.leaseHeartbeatFailures = 0
        w.lastLeaseError = null
      }

      const processRequirement = async (
        w: ReviewWorkerState,
        lane: {
          requirement: any
          tasks?: any[]
          executionSlice?: any | null
          repositories: RequirementRepositoryEntry[]
          leaseGeneration: number
        },
        signal: AbortSignal,
      ) => {
        const requirement = lane.requirement
        const requirementId = requirement.id as string
        const leaseFence = { daemonId, leaseGeneration: lane.leaseGeneration }
        const assertLease = () => leaseSupervisor.assertHealthy(String(w.index))
        const assertActive = () => {
          throwIfCancelled(signal)
          assertLease()
        }
        const fencedPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        const fencedPost = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPost<T>(path, { ...body, ...leaseFence })
        }
        const fencedPut = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPut<T>(path, { ...body, ...leaseFence })
        }
        const recoveryPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertLease()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        try {
          const requirementTasks = Array.isArray(lane.tasks) && lane.tasks.length > 0
            ? lane.tasks
            : Array.isArray(requirement.tasks)
              ? requirement.tasks
              : []
          const commentTaskId = requirementTasks[0]?.id ?? null
          const effectivePolicy = await daemonRequest<EffectiveMergePolicy & {
            requiredChecks: string[]
            requireAiReview: boolean
          }>('GET', `/api/v1/requirements/${requirement.id}/review-policy`)
          const policyChecks = [...new Set([...checks, ...effectivePolicy.requiredChecks])]

          const updateDelivery = (linkId: string, fields: Record<string, unknown>) =>
            fencedPatch(`/api/v1/requirement-repositories/${linkId}/delivery`, fields)
          const workspace = await provisionCompositeWorkspace({
            config: cliConfig,
            requirement,
            executionSlice: lane.executionSlice,
            entries: lane.repositories ?? [],
            updateDelivery,
            preserveDeliveryStatus: true,
            deliveryPhase: 'review',
            signal,
          })

          w.currentRequirementId = requirement.id
          w.requirementTitle = requirement.title
          w.branchName = requirement.branchName ?? `${workspace.repositories.length} repository branches`
          w.worktreePath = workspace.rootPath
          w.startedAt = new Date().toISOString()
          w.activeProcess = true
          await reportDaemonStatus('busy')

          const entryByLink = new Map((lane.repositories ?? []).map((entry) => [entry.link.id, entry]))
          const failures: string[] = []
          const reworkFailures: string[] = []
          for (const repository of workspace.repositories) {
            const entry = entryByLink.get(repository.linkId)
            if (!entry || ['unchanged', 'merged'].includes(entry.link.deliveryStatus)) continue
            const credential = resolveRepositoryCredential(cliConfig, entry.repository, 'push')
            const adapter = getGitProviderAdapter(
              entry.repository.provider,
              (command, args, cwd, environment) => runTrustedGitCommand(command, args, cwd, environment, signal),
            )
            const trustedRun = async (command: string, args: string[], cwd: string) => {
              assertActive()
              if (command !== 'git') {
                return { ok: false, status: null, stdout: '', stderr: 'Only git is allowed in the trusted repository runner.', command }
              }
              return { ...await adapter.git(credential, args, cwd), command: [command, ...args].join(' ') }
            }
            let reviewRunId: string | null = null
            let reviewedHeadCommit: string | null = null
            let forgePullRequest: ForgePullRequest | null = null
            let forgeFailure: ForgeFailure | null = null
            let forgeSyncRevision = entry.link.externalSyncRevision ?? 0
            const forgeCredential = adapter.capabilities.review
              ? resolveRepositoryCredential(cliConfig, entry.repository, 'forge')
              : null
            const forgeOptions = () => ({
              worktreePath: repository.worktreePath,
              branchName: repository.workingBranch,
              baseBranch: effectivePolicy.baseBranch || repository.baseBranch || baseBranch,
              title: requirement.title,
              body: `Automated delivery for ${requirement.title}.`,
              credential: forgeCredential!,
              repository: {
                host: entry.repository.host,
                namespace: entry.repository.namespace,
                name: entry.repository.name,
              },
            })
            await updateDelivery(repository.linkId, {
              deliveryStatus: 'in_review',
              reviewStatus: 'in_review',
              operationCheckpoint: { operation: 'review', status: 'in_progress' },
              lastAttemptAt: new Date().toISOString(),
            })
            const result = await reviewRequirementBranch({
              requirement: {
                id: requirement.id,
                projectId: requirement.projectId,
                title: `${requirement.title} [${repository.displayName}]`,
              },
              branchName: repository.workingBranch,
              worktreePath: repository.worktreePath,
              commentTaskId,
              baseBranch: effectivePolicy.baseBranch || repository.baseBranch || baseBranch,
              checks: policyChecks,
              extraPrompt: extraWorkerPrompt,
              run: trustedRun,
              runCheck: (command, cwd) => runShellCommand(command, cwd, signal),
              runAiReview: reviewTool ? (prompt, cwd) => runAiReview(prompt, cwd, signal) : undefined,
              allowUnreviewed: Boolean(opts.allowUnreviewed),
              onPrepared: async ({ headCommit, baseCommit }) => {
                const run = await fencedPost<{ id: string }>(
                  `/api/v1/requirements/${requirement.id}/review-runs`,
                  {
                    requirementRepositoryId: repository.linkId,
                    headCommit,
                    baseCommit,
                  },
                )
                reviewRunId = run.id
                reviewedHeadCommit = headCommit
                if (adapter.capabilities.review && forgeCredential) {
                  const synchronized = await adapter.findPullRequest(forgeOptions())
                  if (!synchronized.ok) {
                    forgeFailure = synchronized.failure
                    return
                  }
                  if (!synchronized.value) {
                    forgeFailure = {
                      code: 'forge_pull_request_missing',
                      summary: `No pull request exists for ${repository.workingBranch}.`,
                      category: 'configuration',
                      retry: 'manual',
                    }
                    return
                  }
                  forgePullRequest = synchronized.value
                  const syncResult = await fencedPost<{ revision: number }>(
                    `/api/v1/requirement-repositories/${repository.linkId}/forge-sync`,
                    {
                      snapshot: synchronized.value,
                      idempotencyKey: forgeSyncIdempotencyKey(synchronized.value),
                      expectedRevision: forgeSyncRevision,
                      observedAt: new Date().toISOString(),
                    },
                  )
                  forgeSyncRevision = syncResult.revision
                  if (synchronized.value.headCommit && synchronized.value.headCommit !== headCommit) {
                    forgeFailure = {
                      code: 'forge_stale_head',
                      summary: `Pull request head ${synchronized.value.headCommit} does not match reviewed head ${headCommit}.`,
                      category: 'policy',
                      retry: 'manual',
                    }
                  }
                  for (const check of synchronized.value.checks) {
                    await fencedPut(`/api/v1/review-runs/${run.id}/checks`, {
                      name: check.name,
                      provider: synchronized.value.provider,
                      status: check.state,
                      externalUrl: check.url ?? null,
                      summary: check.summary ?? null,
                      details: {},
                      completedAt: ['passed', 'failed', 'skipped'].includes(check.state)
                        ? new Date().toISOString()
                        : null,
                    })
                  }
                  const currentApprovals = synchronized.value.approvals.filter((approval) =>
                    !approval.headCommit || approval.headCommit === headCommit,
                  )
                  const forgeDecision = currentApprovals.some((approval) => approval.state === 'changes_requested')
                    ? 'changes_requested'
                    : currentApprovals.some((approval) => approval.state === 'approved')
                      ? 'approved'
                      : null
                  if (forgeDecision) {
                    await fencedPost(`/api/v1/review-runs/${run.id}/decisions`, {
                      kind: 'forge',
                      decision: forgeDecision,
                      headCommit,
                      summary: `${synchronized.value.provider} pull request ${synchronized.value.externalId}: ${forgeDecision}`,
                      metadata: { approvals: currentApprovals },
                    })
                  }
                }
              },
              onCheckResult: async ({ name, result: checkResult }) => {
                if (!reviewRunId) return
                await fencedPut(`/api/v1/review-runs/${reviewRunId}/checks`, {
                  name,
                  provider: 'local',
                  status: checkResult.ok ? 'passed' : 'failed',
                  summary: redactTrustedOutput(
                    checkResult.ok ? checkResult.stdout : commandFailureSummary(checkResult),
                  ).slice(0, 4000),
                  details: { command: checkResult.command, exitCode: checkResult.status },
                  completedAt: new Date().toISOString(),
                })
              },
              onAiDecision: async (decision) => {
                if (!reviewRunId || !reviewedHeadCommit) return
                await fencedPost(`/api/v1/review-runs/${reviewRunId}/decisions`, {
                  kind: 'ai',
                  decision: decision.approved ? 'approved' : 'changes_requested',
                  headCommit: reviewedHeadCommit,
                  summary: redactTrustedOutput(decision.summary),
                  metadata: { tool: reviewTool },
                })
              },
              addTaskComment: async (taskId, content) => {
                assertActive()
                await daemonPost(`/api/v1/tasks/${taskId}/comments`, { content })
              },
              createFollowupTask: async ({ title, description }) => {
                assertActive()
                await daemonPost(`/api/v1/projects/${requirement.projectId}/tasks`, {
                  title,
                  description: redactTrustedOutput(description),
                  requirementId: requirement.id,
                  priority: 'high',
                  status: 'todo',
                  branchName: repository.workingBranch,
                  tags: ['daemon-review', `repository:${repository.repositoryId}`],
                  ...leaseFence,
                })
              },
              updateRequirementStatus: async () => undefined,
            })
            if (opts.postForgeSummary && forgePullRequest && forgeCredential && !forgeFailure) {
              const posted = await adapter.postReviewSummary({
                ...forgeOptions(),
                pullRequest: forgePullRequest,
                summary: redactTrustedOutput(result.summary),
                decision: 'comment',
              })
              if (posted.ok) forgePullRequest = posted.value
              else forgeFailure = posted.failure
            }
            const structured = reviewRunId
              ? await fencedPost<{
                  run: { status: string }
                  evaluation: { satisfied: boolean; evidence: string[]; blockers: string[] } | null
                }>(`/api/v1/review-runs/${reviewRunId}/evaluate`, {})
              : null
            const structuredApproved = structured?.run.status === 'approved'
            if (forgePullRequest && !forgeFailure) {
              const syncResult = await fencedPost<{ revision: number }>(
                `/api/v1/requirement-repositories/${repository.linkId}/forge-sync`,
                {
                  snapshot: forgePullRequest,
                  idempotencyKey: forgeSyncIdempotencyKey(forgePullRequest),
                  expectedRevision: forgeSyncRevision,
                  observedAt: new Date().toISOString(),
                },
              )
              forgeSyncRevision = syncResult.revision
            }
            const approved = result.status === 'approved' && structuredApproved && !forgeFailure
            const policyEvidence = structured?.evaluation?.evidence ?? []
            const normalizedEvidence = [...new Set(policyEvidence.map((item) =>
              item.startsWith('check:')
                ? 'configured_checks'
                : item.startsWith('human_approvals:')
                  ? 'human_approval'
                  : item === 'manual_override'
                    ? 'manual_override'
                    : item,
            ).filter((item) => [
              'configured_checks',
              'ai_review',
              'human_approval',
              'forge_approval',
              'manual_override',
            ].includes(item)))]
            const policySummary = forgeFailure
              ? `${result.summary}\n- Forge failure (${forgeFailure.code}): ${forgeFailure.summary}`
              : structured?.evaluation && !structured.evaluation.satisfied
              ? `${result.summary}\n- Structured policy blockers: ${structured.evaluation.blockers.join('; ')}`
              : result.summary
            const selectedPolicyMergeMode = effectivePolicy.defaultMergeMode
            const policyManualActionUrl = selectedPolicyMergeMode === 'manual'
              ? manualMergeActionUrl({
                  pullRequestUrl: forgePullRequest?.url ?? entry.link.pullRequestUrl,
                  repositoryWebUrl: entry.repository.webUrl,
                  baseBranch: effectivePolicy.baseBranch || repository.baseBranch || baseBranch,
                  workingBranch: repository.workingBranch,
                })
              : null
            await updateDelivery(repository.linkId, approved ? {
              deliveryStatus: 'ready_to_merge',
              reviewStatus: 'approved',
              mergeStatus: 'ready',
              mergeMode: selectedPolicyMergeMode,
              manualActionUrl: policyManualActionUrl,
              headCommit: reviewedHeadCommit,
              pushedCommit: reviewedHeadCommit,
              failureCode: null,
              failureSummary: null,
              reviewPolicyDecision: 'satisfied',
              reviewPolicyEvidence: normalizedEvidence,
              operationCheckpoint: { operation: 'review', status: 'completed' },
            } : {
              deliveryStatus: 'failed',
              reviewStatus: result.status === 'changes_requested' || result.status === 'conflict'
                ? 'changes_requested'
                : 'failed',
              mergeStatus: 'failed',
              failureCode: forgeFailure?.code ?? (result.status === 'approved' && !structuredApproved
                ? 'review_policy_blocked'
                : result.outcomeCode ?? `review_${result.status}`),
              failureSummary: redactTrustedOutput(policySummary),
              reviewPolicyDecision: structured?.evaluation?.satisfied ? 'satisfied' : 'blocked',
              reviewPolicyEvidence: normalizedEvidence,
              operationCheckpoint: {
                operation: 'review', status: 'failed', summary: redactTrustedOutput(policySummary),
              },
            })
            if (!approved) {
              const failure = `${repository.canonicalKey}: ${result.status}`
              failures.push(failure)
              if (result.status === 'changes_requested' || result.status === 'conflict') {
                reworkFailures.push(failure)
              }
            }
          }
          const nextStatus = reworkFailures.length > 0
            ? 'in_progress'
            : failures.length > 0
              ? 'in_review'
              : 'ready_to_merge'
          await fencedPatch(`/api/v1/requirements/${requirement.id}`, { status: nextStatus })
          console.log(`[Daemon] Review worker ${w.index} finished ${requirement.id}: ${failures.length > 0 ? failures.join(', ') : 'approved'}`)
        } catch (err) {
          if (!signal.aborted) throw err
          const reason = cancellationReason(signal) ?? 'operation cancelled'
          for (const entry of lane.repositories ?? []) {
            await recoveryPatch(`/api/v1/requirement-repositories/${entry.link.id}/delivery`, {
              deliveryStatus: 'failed',
              reviewStatus: 'failed',
              failureCode: 'review_cancelled',
              failureSummary: `Review daemon worker ${w.index} cancelled during drain: ${reason}`,
              lastAttemptAt: new Date().toISOString(),
            }).catch(() => undefined)
          }
          const commentTaskId = lane.tasks?.[0]?.id ?? requirement.tasks?.[0]?.id
          if (commentTaskId) {
            await daemonPost(`/api/v1/tasks/${commentTaskId}/comments`, {
              content: `Review daemon worker ${w.index} was cancelled during drain (${reason}). Delivery attempts were marked retryable and the Requirement remains in review.`,
            }).catch(() => undefined)
          }
        } finally {
          try {
            await daemonPost(`/api/v1/requirements/${requirementId}/release`, {
              reason: `review daemon worker ${w.index} finished`,
              ...leaseFence,
            })
          } catch (err) {
            if (!(err instanceof Error && err.message === 'Requirement is not currently claimed')) {
              console.warn(`[Daemon] Review worker ${w.index} requirement release skipped:`, err instanceof Error ? err.message : String(err))
            }
          }
          leaseSupervisor.unregister(String(w.index))
          resetWorker(w)
        }
      }

      const pollReview = async (w: ReviewWorkerState) => {
        if (stopping || lifecycle.isDraining || w.activeProcess) return
        try {
          const lane = await applyReviewCandidate(w)
          if (lane.requirement && lane.leaseGeneration) {
            if (lifecycle.isDraining) {
              await daemonPost(`/api/v1/requirements/${lane.requirement.id}/release`, {
                reason: 'review daemon entered drain mode during acquisition',
                daemonId,
                leaseGeneration: lane.leaseGeneration,
              }).catch(() => undefined)
              return
            }
            const operation = lifecycle.start(String(w.index))
            w.currentRequirementId = lane.requirement.id
            w.requirementTitle = lane.requirement.title
            w.startedAt = new Date().toISOString()
            w.activeProcess = true
            w.leaseGeneration = lane.leaseGeneration
            w.leaseHealthy = true
            w.leaseHeartbeatFailures = 0
            w.lastLeaseError = null
            leaseSupervisor.register({
              key: String(w.index),
              requirementId: lane.requirement.id,
              generation: lane.leaseGeneration,
            })
            await reportDaemonStatus('busy')
            try {
              await processRequirement(w, lane as {
                requirement: any
                tasks?: any[]
                executionSlice?: any | null
                repositories: RequirementRepositoryEntry[]
                leaseGeneration: number
              }, operation.signal)
            } finally {
              operation.complete()
            }
            await reportDaemonStatus(workers.some(worker => worker.activeProcess) ? 'busy' : 'idle')
            if (opts.once) {
              await stopReviewDaemon('idle', 0)
            }
            return
          }
          if (opts.once) {
            await stopReviewDaemon('idle', 0)
            return
          }
        } catch (err) {
          console.error(`[Daemon] Review worker ${w.index} polling failed:`, err instanceof Error ? err.message : String(err))
        }
        if (!stopping && !lifecycle.isDraining) {
          pollTimers[w.index] = setTimeout(() => pollReview(w), intervalMs)
        }
      }

      const drainReviewDaemon = async (reason: 'SIGINT' | 'SIGTERM') => {
        if (stopping) return
        stopping = true
        retryWakeCleanup?.()
        console.log(`\n[Daemon] ${reason} received; draining review workers...`)
        for (const timer of pollTimers) {
          if (timer) clearTimeout(timer)
        }
        const drained = lifecycle.drain(reason)
        await reportDaemonStatus(lifecycle.activeOperations > 0 ? 'busy' : 'offline')
        await drained
        leaseSupervisor.stop()
        await reportDaemonStatus('offline')
        process.exitCode = 0
      }

      process.once('SIGINT', () => { void drainReviewDaemon('SIGINT') })
      process.once('SIGTERM', () => { void drainReviewDaemon('SIGTERM') })

      await reportDaemonStatus('idle')
      if (reviewDaemonConfig.mode === 'sse') {
        retryWakeCleanup = startRoleRetryWakeStream({
          apiUrl: cliConfig.apiUrl,
          endpoint: reviewDaemonConfig.sseEndpoint,
          apiKey: cliConfig.apiKey,
          daemonId,
          role: 'reviewer',
          onWake: () => {
            for (const worker of workers) {
              if (pollTimers[worker.index]) clearTimeout(pollTimers[worker.index]!)
              if (!worker.activeProcess) void pollReview(worker)
            }
          },
        })
      }
      for (const w of workers) {
        pollReview(w)
      }
    })

  daemon
    .command('merge')
    .description('merge reviewed requirements through the configured provider, direct Git, or a manual handoff')
    .requiredOption('--project <id>', 'project ID to merge')
    .option('--base <branch>', 'base branch to merge into (default: main)', 'main')
    .option('--id <uuid>', 'merger instance ID (defaults to a unique process ID)')
    .option('--workers <n>', 'number of parallel merge workers (default: 1)')
    .option('--mode <mode>', 'merge mode: auto, provider, direct, or manual (default: auto)', 'auto')
    .option('--once', 'process at most one acquired requirement, then exit')
    .action(async (opts) => {
      const cliConfig = loadConfig()
      const baseBranch = opts.base as string
      const requestedMergeMode = opts.mode as RequestedMergeMode
      if (!['auto', 'provider', 'direct', 'manual'].includes(requestedMergeMode)) {
        throw new Error(`Invalid merge mode '${requestedMergeMode}'. Expected auto, provider, direct, or manual.`)
      }

      const identity = resolveDaemonProcessIdentity('merger', opts.id, cliConfig)
      const daemonId = identity.instanceId
      const actorId = identity.actorId

      process.env.TW_ACTOR_ID = actorId
      const daemonRequest = <T>(method: string, path: string, body?: unknown) =>
        request<T>(method, path, body, { actorId, actorType: 'agent', omitAuth: true })
      const daemonPost = <T>(path: string, body: unknown) => daemonRequest<T>('POST', path, body)
      const daemonPatch = <T>(path: string, body: unknown) => daemonRequest<T>('PATCH', path, body)

      const host = hostname()
      const numWorkers = Math.max(1, parseInt(opts.workers ?? '1', 10) || 1)
      console.log(`[Daemon] Starting merger... Instance: ${daemonId}, Actor: ${actorId}, Host: ${host}, Workers: ${numWorkers}, Base: ${baseBranch}`)

      const mergeRegistration = await daemonPost<any>('/api/v1/daemons/register', {
        id: daemonId,
        name: `merge-daemon-${host}`,
        role: 'merger',
        capabilities: ['merge'],
        host,
        processStartedAt: identity.processStartedAt,
        workerCapacity: numWorkers,
      })
      const mergeDaemonConfig: DaemonConfig = mergeRegistration.config ?? {
        mode: 'polling',
        pollingIntervalMs: 15_000,
        pollingBackoffMax: 60_000,
      }

      const workers: ReviewWorkerState[] = Array.from({ length: numWorkers }, (_, index) => ({
        index,
        currentRequirementId: null,
        requirementTitle: null,
        branchName: null,
        worktreePath: null,
        startedAt: null,
        activeProcess: false,
        leaseGeneration: null,
        leaseHealthy: null,
        leaseHeartbeatFailures: 0,
        lastLeaseError: null,
      }))

      let stopping = false
      const lifecycle = new DaemonLifecycle()
      const intervalMs = Number(process.env.TW_DAEMON_MERGE_POLL_INTERVAL_MS) || 15_000
      const pollTimers: Array<ReturnType<typeof setTimeout> | null> = Array.from({ length: numWorkers }, () => null)
      let retryWakeCleanup: (() => void) | null = null

      const reportDaemonStatus = async (status: 'idle' | 'busy' | 'offline') => {
        const activeWorkerStates = workers.map((w) => ({
          index: w.index,
          status: lifecycle.isDraining && w.activeProcess ? 'stopping' : w.activeProcess ? 'running' : 'idle',
          requirementId: w.currentRequirementId,
          requirementTitle: w.requirementTitle,
          taskId: null,
          taskTitle: null,
          branchName: w.branchName,
          worktreePath: w.worktreePath,
          startedAt: w.startedAt,
          leaseGeneration: w.leaseGeneration,
          leaseHealthy: w.leaseHealthy,
          leaseHeartbeatFailures: w.leaseHeartbeatFailures,
          lastLeaseError: w.lastLeaseError,
          updatedAt: new Date().toISOString(),
        }))
        try {
          await daemonPost(`/api/v1/daemons/${daemonId}/status`, {
            status,
            activeTaskIds: [],
            activeWorkerStates,
          })
        } catch (err) {
          console.error('[Daemon] Failed to report merge daemon status:', err instanceof Error ? err.message : String(err))
        }
      }

      const leaseSupervisor = new LeaseSupervisor({
        heartbeatProcess: () => daemonPost(`/api/v1/daemons/${daemonId}/heartbeat`, {}),
        heartbeatLease: (lease) => daemonPost(`/api/v1/requirements/${lease.requirementId}/heartbeat`, {
          extendMinutes: 5,
          daemonId,
          leaseGeneration: lease.generation,
        }),
        onHealthChange: (snapshot) => {
          const worker = workers[Number(snapshot.key)]
          if (!worker) return
          applyLeaseSnapshot(worker, snapshot)
          if (!snapshot.healthy) {
            console.error(`[Daemon] Merge worker ${worker.index} lease became unhealthy: ${snapshot.lastError ?? 'unknown heartbeat failure'}`)
          }
          void reportDaemonStatus(workers.some((candidate) => candidate.activeProcess) ? 'busy' : 'idle')
        },
        onProcessError: (error) => {
          if (error) console.error(`[Daemon] Merge process heartbeat failed: ${error}`)
        },
      })
      leaseSupervisor.start()

      const stopMergeDaemon = async (status: 'idle' | 'busy' | 'offline', exitCode: number) => {
        if (stopping) return
        stopping = true
        retryWakeCleanup?.()
        leaseSupervisor.stop()
        for (const timer of pollTimers) {
          if (timer) clearTimeout(timer)
        }
        await reportDaemonStatus(status)
        if (lifecycle.activeOperations === 0 && lifecycle.phase === 'running') lifecycle.stop()
        process.exitCode = exitCode
      }

      const applyMergeCandidate = async (w: ReviewWorkerState) => {
        const lane = await daemonPost<{
          requirement: any | null
          tasks: any[]
          executionSlice?: any | null
          repositories: RequirementRepositoryEntry[]
          leaseGeneration?: number
        }>(
          `/api/v1/daemons/${daemonId}/apply-merge`,
          {
            projectId: opts.project,
            workerIndex: w.index,
          },
        )
        return { ...lane, repositories: normalizeRequirementRepositoryEntries(lane.repositories || []) }
      }

      const resetWorker = (w: ReviewWorkerState) => {
        w.currentRequirementId = null
        w.requirementTitle = null
        w.branchName = null
        w.worktreePath = null
        w.startedAt = null
        w.activeProcess = false
        w.leaseGeneration = null
        w.leaseHealthy = null
        w.leaseHeartbeatFailures = 0
        w.lastLeaseError = null
      }

      const processRequirement = async (
        w: ReviewWorkerState,
        lane: {
          requirement: any
          tasks?: any[]
          executionSlice?: any | null
          repositories: RequirementRepositoryEntry[]
          leaseGeneration: number
        },
        signal: AbortSignal,
      ) => {
        const requirement = lane.requirement
        const requirementId = requirement.id as string
        const leaseFence = { daemonId, leaseGeneration: lane.leaseGeneration }
        const assertLease = () => leaseSupervisor.assertHealthy(String(w.index))
        const assertActive = () => {
          throwIfCancelled(signal)
          assertLease()
        }
        const fencedPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        const fencedPost = async <T>(path: string, body: Record<string, unknown>) => {
          assertActive()
          return daemonPost<T>(path, { ...body, ...leaseFence })
        }
        const recoveryPatch = async <T>(path: string, body: Record<string, unknown>) => {
          assertLease()
          return daemonPatch<T>(path, { ...body, ...leaseFence })
        }
        try {
          const requirementTasks = Array.isArray(lane.tasks) && lane.tasks.length > 0
            ? lane.tasks
            : Array.isArray(requirement.tasks)
              ? requirement.tasks
              : []
          const commentTaskId = requirementTasks[0]?.id ?? null

          const effectivePolicy = await daemonRequest<EffectiveMergePolicy>(
            'GET',
            `/api/v1/requirements/${requirement.id}/review-policy`,
          )
          let mergeMode: 'provider' | 'direct' | 'manual'
          try {
            mergeMode = selectMergeMode(effectivePolicy, requestedMergeMode)
          } catch (error) {
            const summary = error instanceof Error ? error.message : String(error)
            for (const entry of lane.repositories ?? []) {
              if (['unchanged', 'merged'].includes(entry.link.deliveryStatus)) continue
              await fencedPatch(`/api/v1/requirement-repositories/${entry.link.id}/delivery`, {
                deliveryStatus: 'failed',
                mergeStatus: 'failed',
                failureCode: 'merge_mode_not_allowed',
                failureSummary: summary,
                operationCheckpoint: { operation: 'merge', status: 'failed', summary },
              })
            }
            await fencedPatch(`/api/v1/requirements/${requirement.id}`, { status: 'ready_to_merge' })
            if (commentTaskId) {
              await daemonPost(`/api/v1/tasks/${commentTaskId}/comments`, {
                content: `Merge daemon could not continue: ${summary}`,
              })
            }
            return
          }
          const mergeBaseBranch = effectivePolicy.baseBranch || baseBranch

          const updateDelivery = (linkId: string, fields: Record<string, unknown>) =>
            fencedPatch(`/api/v1/requirement-repositories/${linkId}/delivery`, fields)
          const workspace = await provisionCompositeWorkspace({
            config: cliConfig,
            requirement,
            executionSlice: lane.executionSlice,
            entries: lane.repositories ?? [],
            updateDelivery,
            preserveDeliveryStatus: true,
            deliveryPhase: 'merge',
            signal,
          })

          w.currentRequirementId = requirement.id
          w.requirementTitle = requirement.title
          w.branchName = requirement.branchName ?? `${workspace.repositories.length} repository branches`
          w.worktreePath = workspace.rootPath
          w.startedAt = new Date().toISOString()
          w.activeProcess = true
          await reportDaemonStatus('busy')

          const entryByLink = new Map((lane.repositories ?? []).map((entry) => [entry.link.id, entry]))
          const failures: string[] = []
          const reworkFailures: string[] = []
          const reviewFailures: string[] = []
          const manualActions: string[] = []
          for (const repository of workspace.repositories) {
            const entry = entryByLink.get(repository.linkId)
            if (!entry || ['unchanged', 'merged'].includes(entry.link.deliveryStatus)) continue
            const adapter = getGitProviderAdapter(
              entry.repository.provider,
              (command, args, cwd, environment) => runTrustedGitCommand(command, args, cwd, environment, signal),
            )

            if (mergeMode === 'manual') {
              const actionUrl = manualMergeActionUrl({
                pullRequestUrl: entry.link.pullRequestUrl,
                repositoryWebUrl: entry.repository.webUrl,
                baseBranch: mergeBaseBranch,
                workingBranch: repository.workingBranch,
              })
              const summary = actionUrl
                ? `Manual merge required for ${repository.canonicalKey}: ${actionUrl}`
                : `Manual merge required for ${repository.canonicalKey}; no provider URL is available.`
              await updateDelivery(repository.linkId, {
                deliveryStatus: 'ready_to_merge',
                mergeStatus: 'ready',
                mergeMode: 'manual',
                manualActionUrl: actionUrl,
                failureCode: null,
                failureSummary: null,
                operationCheckpoint: { operation: 'merge', status: 'skipped', summary },
                lastAttemptAt: new Date().toISOString(),
              })
              manualActions.push(`${repository.canonicalKey}${actionUrl ? `: ${actionUrl}` : ''}`)
              if (commentTaskId) {
                await daemonPost(`/api/v1/tasks/${commentTaskId}/comments`, { content: summary })
              }
              continue
            }

            await updateDelivery(repository.linkId, {
              deliveryStatus: 'ready_to_merge',
              mergeStatus: 'merging',
              mergeMode,
              manualActionUrl: null,
              operationCheckpoint: { operation: 'merge', status: 'in_progress' },
              lastAttemptAt: new Date().toISOString(),
            })

            if (mergeMode === 'provider') {
              let forgeSyncRevision = entry.link.externalSyncRevision ?? 0
              const forgeCredential = resolveRepositoryCredential(cliConfig, entry.repository, 'forge')
              const forgeOptions = {
                worktreePath: repository.worktreePath,
                branchName: repository.workingBranch,
                baseBranch: mergeBaseBranch,
                title: requirement.title,
                body: `Automated delivery for ${requirement.title}.`,
                credential: forgeCredential,
                repository: {
                  host: entry.repository.host,
                  namespace: entry.repository.namespace,
                  name: entry.repository.name,
                },
              }
              const found = adapter.capabilities.merge
                ? await adapter.findPullRequest(forgeOptions)
                : { ok: false as const, failure: {
                    code: 'forge_not_supported',
                    summary: `Repository provider '${entry.repository.provider}' does not support provider-native merge`,
                    category: 'not_supported' as const,
                    retry: 'manual' as const,
                  } }
              let pullRequest: ForgePullRequest | null = found.ok ? found.value : null
              let forgeFailure: ForgeFailure | null = found.ok
                ? pullRequest ? null : {
                    code: 'forge_pull_request_missing',
                    summary: 'No pull request exists for the reviewed branch',
                    category: 'policy',
                    retry: 'manual',
                  }
                : found.failure
              if (pullRequest) {
                const syncResult = await fencedPost<{ revision: number }>(
                  `/api/v1/requirement-repositories/${repository.linkId}/forge-sync`,
                  {
                    snapshot: pullRequest,
                    idempotencyKey: forgeSyncIdempotencyKey(pullRequest),
                    expectedRevision: forgeSyncRevision,
                    observedAt: new Date().toISOString(),
                  },
                )
                forgeSyncRevision = syncResult.revision
              }
              const expectedHeadCommit = entry.link.pushedCommit ?? entry.link.headCommit ?? pullRequest?.headCommit ?? null
              if (!forgeFailure && pullRequest && !expectedHeadCommit) {
                forgeFailure = {
                  code: 'forge_head_commit_missing',
                  summary: 'The reviewed commit is unavailable, so provider merge cannot be fenced safely',
                  category: 'policy',
                  retry: 'manual',
                }
              }
              if (!forgeFailure && pullRequest && expectedHeadCommit) {
                const mergeResult = await adapter.mergePullRequest({
                  ...forgeOptions,
                  pullRequest,
                  expectedHeadCommit,
                })
                if (mergeResult.ok) {
                  pullRequest = mergeResult.value
                  if (pullRequest.state !== 'merged') {
                    forgeFailure = {
                      code: 'forge_merge_unconfirmed',
                      summary: 'Provider accepted the merge request but did not confirm a merged pull request',
                      category: 'infrastructure',
                      retry: 'automatic',
                    }
                  }
                } else {
                  forgeFailure = mergeResult.failure
                }
              }
              if (pullRequest && !forgeFailure) {
                const syncResult = await fencedPost<{ revision: number }>(
                  `/api/v1/requirement-repositories/${repository.linkId}/forge-sync`,
                  {
                    snapshot: pullRequest,
                    idempotencyKey: forgeSyncIdempotencyKey(pullRequest),
                    expectedRevision: forgeSyncRevision,
                    observedAt: new Date().toISOString(),
                  },
                )
                forgeSyncRevision = syncResult.revision
              }
              await updateDelivery(repository.linkId, forgeFailure ? {
                deliveryStatus: 'failed',
                mergeStatus: 'failed',
                mergeMode: 'provider',
                pullRequestProvider: pullRequest?.provider ?? entry.link.pullRequestProvider ?? entry.repository.provider,
                pullRequestExternalId: pullRequest?.externalId ?? entry.link.pullRequestExternalId ?? null,
                pullRequestUrl: pullRequest?.url ?? entry.link.pullRequestUrl ?? null,
                failureCode: forgeFailure.code,
                failureSummary: redactTrustedOutput(forgeFailure.summary),
                operationCheckpoint: { operation: 'merge', status: 'failed', summary: redactTrustedOutput(forgeFailure.summary) },
              } : {
                deliveryStatus: 'merged',
                reviewStatus: 'approved',
                mergeStatus: 'merged',
                mergeMode: 'provider',
                pullRequestProvider: pullRequest!.provider,
                pullRequestExternalId: pullRequest!.externalId,
                pullRequestUrl: pullRequest!.url,
                mergedAt: new Date().toISOString(),
                failureCode: null,
                failureSummary: null,
                operationCheckpoint: { operation: 'merge', status: 'completed' },
              })
              if (forgeFailure) {
                const failure = `${repository.canonicalKey}: ${forgeFailure.code}`
                failures.push(failure)
                if (['forge_stale_head', 'forge_pull_request_closed'].includes(forgeFailure.code)) {
                  reviewFailures.push(failure)
                }
              }
              continue
            }

            const credential = resolveRepositoryCredential(cliConfig, entry.repository, 'push')
            const trustedRun = async (command: string, args: string[], cwd: string) => {
              assertActive()
              if (command !== 'git') {
                return { ok: false, status: null, stdout: '', stderr: 'Only git is allowed in the trusted repository runner.', command }
              }
              return { ...await adapter.git(credential, args, cwd), command: [command, ...args].join(' ') }
            }
            const mergeWorktreePath = await withRepositoryWorkspaceLock({
              config: cliConfig,
              repository: entry.repository,
              operation: 'merge-worktree',
              signal,
            }, () => ensureDetachedReviewWorktree(
              repository.basePath,
              `${requirement.id}-${repository.repositoryId}`,
              repository.workingBranch,
              mergeBaseBranch,
              signal,
            ))
            const result = await mergeRequirementBranch({
              requirement: {
                id: requirement.id,
                projectId: requirement.projectId,
                title: `${requirement.title} [${repository.displayName}]`,
              },
              branchName: repository.workingBranch,
              mergeWorktreePath,
              commentTaskId,
              baseBranch: mergeBaseBranch,
              run: trustedRun,
              addTaskComment: async (taskId, content) => {
                assertActive()
                await daemonPost(`/api/v1/tasks/${taskId}/comments`, { content })
              },
              createFollowupTask: async ({ title, description }) => {
                assertActive()
                await daemonPost(`/api/v1/projects/${requirement.projectId}/tasks`, {
                  title,
                  description: redactTrustedOutput(description),
                  requirementId: requirement.id,
                  priority: 'high',
                  status: 'todo',
                  branchName: repository.workingBranch,
                  tags: ['daemon-merge', `repository:${repository.repositoryId}`],
                  ...leaseFence,
                })
              },
              updateRequirementStatus: async () => undefined,
            })
            const merged = result.status === 'merged'
            await updateDelivery(repository.linkId, merged ? {
              deliveryStatus: 'merged',
              reviewStatus: 'approved',
              mergeStatus: 'merged',
              mergeMode: 'direct',
              manualActionUrl: null,
              mergedAt: new Date().toISOString(),
              failureCode: null,
              failureSummary: null,
              operationCheckpoint: { operation: 'merge', status: 'completed' },
            } : {
              deliveryStatus: 'failed',
              mergeStatus: 'failed',
              mergeMode: 'direct',
              failureCode: result.outcomeCode ?? `merge_${result.status}`,
              failureSummary: redactTrustedOutput(result.summary),
              operationCheckpoint: {
                operation: 'merge', status: 'failed', summary: redactTrustedOutput(result.summary),
              },
            })
            if (!merged) {
              failures.push(`${repository.canonicalKey}: ${result.status}`)
              if (result.status === 'conflict') reworkFailures.push(`${repository.canonicalKey}: ${result.status}`)
            }
          }
          const nextStatus = reworkFailures.length > 0
            ? 'in_progress'
            : reviewFailures.length > 0
              ? 'in_review'
            : failures.length > 0 || manualActions.length > 0
              ? 'ready_to_merge'
              : 'done'
          await fencedPatch(`/api/v1/requirements/${requirement.id}`, { status: nextStatus })
          const resultSummary = failures.length > 0
            ? failures.join(', ')
            : manualActions.length > 0
              ? `manual action: ${manualActions.join(', ')}`
              : 'merged'
          console.log(`[Daemon] Merge worker ${w.index} finished ${requirement.id}: ${resultSummary}`)
        } catch (err) {
          if (!signal.aborted) throw err
          const reason = cancellationReason(signal) ?? 'operation cancelled'
          for (const entry of lane.repositories ?? []) {
            await recoveryPatch(`/api/v1/requirement-repositories/${entry.link.id}/delivery`, {
              deliveryStatus: 'failed',
              mergeStatus: 'failed',
              failureCode: 'merge_cancelled',
              failureSummary: `Merge daemon worker ${w.index} cancelled during drain: ${reason}`,
              lastAttemptAt: new Date().toISOString(),
            }).catch(() => undefined)
          }
          const commentTaskId = lane.tasks?.[0]?.id ?? requirement.tasks?.[0]?.id
          if (commentTaskId) {
            await daemonPost(`/api/v1/tasks/${commentTaskId}/comments`, {
              content: `Merge daemon worker ${w.index} was cancelled during drain (${reason}). Delivery attempts were marked retryable and the Requirement remains ready to merge.`,
            }).catch(() => undefined)
          }
        } finally {
          try {
            await daemonPost(`/api/v1/requirements/${requirementId}/release`, {
              reason: `merge daemon worker ${w.index} finished`,
              ...leaseFence,
            })
          } catch (err) {
            if (!(err instanceof Error && err.message === 'Requirement is not currently claimed')) {
              console.warn(`[Daemon] Merge worker ${w.index} requirement release skipped:`, err instanceof Error ? err.message : String(err))
            }
          }
          leaseSupervisor.unregister(String(w.index))
          resetWorker(w)
        }
      }

      const pollMerge = async (w: ReviewWorkerState) => {
        if (stopping || lifecycle.isDraining || w.activeProcess) return
        try {
          const lane = await applyMergeCandidate(w)
          if (lane.requirement && lane.leaseGeneration) {
            if (lifecycle.isDraining) {
              await daemonPost(`/api/v1/requirements/${lane.requirement.id}/release`, {
                reason: 'merge daemon entered drain mode during acquisition',
                daemonId,
                leaseGeneration: lane.leaseGeneration,
              }).catch(() => undefined)
              return
            }
            const operation = lifecycle.start(String(w.index))
            w.currentRequirementId = lane.requirement.id
            w.requirementTitle = lane.requirement.title
            w.startedAt = new Date().toISOString()
            w.activeProcess = true
            w.leaseGeneration = lane.leaseGeneration
            w.leaseHealthy = true
            w.leaseHeartbeatFailures = 0
            w.lastLeaseError = null
            leaseSupervisor.register({
              key: String(w.index),
              requirementId: lane.requirement.id,
              generation: lane.leaseGeneration,
            })
            await reportDaemonStatus('busy')
            try {
              await processRequirement(w, lane as {
                requirement: any
                tasks?: any[]
                executionSlice?: any | null
                repositories: RequirementRepositoryEntry[]
                leaseGeneration: number
              }, operation.signal)
            } finally {
              operation.complete()
            }
            await reportDaemonStatus(workers.some(worker => worker.activeProcess) ? 'busy' : 'idle')
            if (opts.once) {
              await stopMergeDaemon('idle', 0)
            }
            return
          }
          if (opts.once) {
            await stopMergeDaemon('idle', 0)
            return
          }
        } catch (err) {
          console.error(`[Daemon] Merge worker ${w.index} polling failed:`, err instanceof Error ? err.message : String(err))
        }
        if (!stopping && !lifecycle.isDraining) {
          pollTimers[w.index] = setTimeout(() => pollMerge(w), intervalMs)
        }
      }

      const drainMergeDaemon = async (reason: 'SIGINT' | 'SIGTERM') => {
        if (stopping) return
        stopping = true
        retryWakeCleanup?.()
        console.log(`\n[Daemon] ${reason} received; draining merge workers...`)
        for (const timer of pollTimers) {
          if (timer) clearTimeout(timer)
        }
        const drained = lifecycle.drain(reason)
        await reportDaemonStatus(lifecycle.activeOperations > 0 ? 'busy' : 'offline')
        await drained
        leaseSupervisor.stop()
        await reportDaemonStatus('offline')
        process.exitCode = 0
      }

      process.once('SIGINT', () => { void drainMergeDaemon('SIGINT') })
      process.once('SIGTERM', () => { void drainMergeDaemon('SIGTERM') })

      await reportDaemonStatus('idle')
      if (mergeDaemonConfig.mode === 'sse') {
        retryWakeCleanup = startRoleRetryWakeStream({
          apiUrl: cliConfig.apiUrl,
          endpoint: mergeDaemonConfig.sseEndpoint,
          apiKey: cliConfig.apiKey,
          daemonId,
          role: 'merger',
          onWake: () => {
            for (const worker of workers) {
              if (pollTimers[worker.index]) clearTimeout(pollTimers[worker.index]!)
              if (!worker.activeProcess) void pollMerge(worker)
            }
          },
        })
      }
      for (const w of workers) {
        pollMerge(w)
      }
    })

  daemon
    .command('progress')
    .description('inspect authoritative worker progress or append-only handoff history')
    .option('--daemon <id>', 'filter by daemon instance ID')
    .option('--requirement <id>', 'filter by Requirement ID')
    .option('--run <id>', 'filter by worker run ID')
    .option('--worker <n>', 'filter by worker index')
    .option('--history', 'show append-only progress history instead of current state')
    .option('--limit <n>', 'maximum rows to return (default: 50)', '50')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get<{ items: Record<string, unknown>[] }>(
        daemonProgressPath({
          daemonId: opts.daemon,
          requirementId: opts.requirement,
          runId: opts.run,
          workerIndex: opts.worker,
          history: opts.history,
          limit: opts.limit,
        }),
      )
      if (opts.json) return printJson(data)
      printTable(data.items, opts.history
        ? [
            'occurredAt',
            'daemonId',
            'workerIndex',
            'runId',
            'requirementId',
            'executionSliceId',
            'currentTaskId',
            'phase',
            'source',
            'workspaceState',
            'recoveryDisposition',
            'retryCount',
            'message',
            'handoffSummary',
          ]
        : [
            'lastEventAt',
            'daemonId',
            'workerIndex',
            'runId',
            'requirementId',
            'executionSliceId',
            'currentTaskId',
            'phase',
            'workspaceState',
            'recoveryDisposition',
            'retryCount',
            'message',
            'handoffSummary',
        ])
    })

  daemon
    .command('status')
    .description('show the atomic daemon observability overview')
    .option('--watch', 'refresh until interrupted')
    .option('--interval <seconds>', 'watch refresh interval (default: 5)', '5')
    .option('--project <id>', 'restrict queue and workers to a project')
    .option('--json', 'output JSON (one object per watch refresh)')
    .action(async (opts) => {
      let stopped = false
      const stop = () => { stopped = true }
      if (opts.watch) process.once('SIGINT', stop)
      do {
        const query = opts.project ? `?projectId=${encodeURIComponent(opts.project)}` : ''
        const data = await get<any>(`/api/v1/observability/overview${query}`)
        if (opts.json) {
          console.log(JSON.stringify(data))
        } else {
          printTable((data.daemons ?? []) as Record<string, unknown>[], [
            'name', 'role', 'status', 'liveness', 'health', 'controlState', 'activeWorkerCount', 'workerCapacity', 'lastHeartbeatAt',
          ])
          console.log(`queue=${data.queue?.total ?? 0} alerts=${data.alerts?.length ?? 0} asOf=${data.asOf ?? '—'}`)
          if (Array.isArray(data.nextActions) && data.nextActions.length > 0) {
            printTable(data.nextActions.slice(0, 8) as Record<string, unknown>[], [
              'kind', 'reason', 'confidence', 'policy', 'nextActionAt', 'requiredRole', 'requiredCapability',
            ])
          }
        }
        if (!opts.watch || stopped) break
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(opts.interval) || 5) * 1000))
      } while (!stopped)
      if (opts.watch) process.removeListener('SIGINT', stop)
    })

  daemon
    .command('run <runId>')
    .description('inspect a correlated worker run')
    .option('--limit <n>', 'maximum events (default: 100)', '100')
    .option('--cursor <cursor>', 'continue from an opaque history cursor')
    .option('--json', 'output raw JSON')
    .action(async (runId, opts) => {
      const data = await get<any>(daemonHistoryPath({ runId, limit: opts.limit, cursor: opts.cursor }))
      if (opts.json) return printJson(data)
      printTable((data.items ?? []) as Record<string, unknown>[], ['occurredAt', 'kind', 'severity', 'title', 'summary', 'runId', 'taskId', 'isSnapshot'])
      if (data.nextCursor) console.log(`nextCursor=${data.nextCursor}`)
    })

  daemon
    .command('metrics')
    .description('show daemon and worker time-series metrics and runbook alerts')
    .option('--project <id>', 'restrict metrics to a project')
    .option('--window-hours <n>', 'time window in hours (default: 24)', '24')
    .option('--bucket-minutes <n>', 'bucket resolution in minutes (default: 60)', '60')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const query = new URLSearchParams({
        windowHours: String(opts.windowHours),
        bucketMinutes: String(opts.bucketMinutes),
      })
      if (opts.project) query.set('projectId', opts.project)
      const data = await get<any>(`/api/v1/observability/metrics?${query.toString()}`)
      if (opts.json) return printJson(data)
      const aggregate = data.series?.find((series: Record<string, unknown>) => series.id === 'aggregate')
      const latest = aggregate?.points?.at?.(-1)
      printTable((data.alerts ?? []) as Record<string, unknown>[], ['code', 'severity', 'message', 'runbook'])
      console.log(`samples=${data.sampleCount ?? 0} noData=${data.noData ? 'yes' : 'no'} latest=${JSON.stringify(latest?.values ?? {})}`)
    })

  daemon
    .command('events')
    .description('inspect correlated daemon events')
    .option('--follow', 'poll for new events until interrupted')
    .option('--daemon <id>', 'filter by daemon instance ID')
    .option('--requirement <id>', 'filter by Requirement ID')
    .option('--run <id>', 'filter by worker run ID')
    .option('--kind <kind>', 'progress|task|delivery|review|merge|retry|control')
    .option('--severity <severity>', 'debug|info|warn|error')
    .option('--limit <n>', 'maximum events per request (default: 100)', '100')
    .option('--json', 'output JSON (one object per event page)')
    .action(async (opts) => {
      let stopped = false
      let cursor: string | undefined
      const seen = new Set<string>()
      const stop = () => { stopped = true }
      if (opts.follow) process.once('SIGINT', stop)
      do {
        const data = await get<any>(daemonHistoryPath({
          daemonId: opts.daemon,
          requirementId: opts.requirement,
          runId: opts.run,
          kind: opts.kind,
          severity: opts.severity,
          cursor,
          limit: opts.limit,
        }))
        const freshItems = (data.items ?? []).filter((item: Record<string, unknown>) => {
          const id = String(item.eventId ?? item.id ?? '')
          if (!id || seen.has(id)) return false
          seen.add(id)
          return true
        })
        const freshData = { ...data, items: freshItems }
        if (opts.json) {
          console.log(JSON.stringify(freshData))
        } else {
          printTable(freshItems as Record<string, unknown>[], ['occurredAt', 'kind', 'severity', 'title', 'summary', 'eventId', 'isSnapshot'])
        }
        if (!opts.follow || stopped) break
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        cursor = undefined
      } while (!stopped)
      if (opts.follow) process.removeListener('SIGINT', stop)
    })

  daemon
    .command('logs')
    .description('show a bounded, redacted structured log tail')
    .option('--daemon <id>', 'filter by daemon instance ID')
    .option('--requirement <id>', 'filter by Requirement ID')
    .option('--run <id>', 'filter by worker run ID')
    .option('--max-chars <n>', 'maximum returned characters (default: 4000)', '4000')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get<any>(daemonHistoryPath({
        daemonId: opts.daemon,
        requirementId: opts.requirement,
        runId: opts.run,
        maxChars: opts.maxChars,
        logs: true,
      }))
      if (opts.json) return printJson(data)
      printTable((data.items ?? []) as Record<string, unknown>[], ['occurredAt', 'runId', 'workerIndex', 'message', 'truncated'])
    })

  daemon
    .command('list')
    .description('list online task runner daemons')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get<{ items: unknown[] }>('/api/v1/daemons')
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], [
        'instanceId',
        'role',
        'actorId',
        'name',
        'host',
        'status',
        'workerCapacity',
        'processStartedAt',
        'lastHeartbeatAt',
      ])
    })
}
