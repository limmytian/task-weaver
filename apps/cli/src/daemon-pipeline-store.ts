import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type {
  DaemonPipelineConfig,
  PipelineRole,
  PipelineRunMode,
} from './daemon-pipeline-config.js'
import type { PipelineLaunchPlan } from './daemon-pipeline.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PipelineRuntimeStatus = 'starting' | 'running' | 'draining' | 'stopped' | 'failed'
export type PipelineRoleStatus = 'starting' | 'running' | 'draining' | 'paused' | 'stopped' | 'failed'
export type PipelineRoleDesiredState = 'running' | 'paused' | 'stopped'
export type PipelineControlAction = 'pause' | 'drain' | 'resume' | 'restart' | 'stop'

export interface PipelineRoleRuntimeState {
  role: PipelineRole
  instanceId: string
  status: PipelineRoleStatus
  desiredState: PipelineRoleDesiredState
  pid: number | null
  restartCount: number
  startedAt: string | null
  stoppedAt: string | null
  lastExitCode: number | null
  lastSignal: string | null
  lastFailureCode: string | null
}

export interface PipelineRuntimeState {
  version: 1
  runId: string
  projectId: string
  configPath: string
  runMode: PipelineRunMode
  supervisorPid: number
  status: PipelineRuntimeStatus
  startedAt: string
  updatedAt: string
  stoppedAt: string | null
  exitCode: number | null
  roles: Record<PipelineRole, PipelineRoleRuntimeState | null>
}

export interface PipelineControlCommand {
  id: string
  action: PipelineControlAction
  role?: PipelineRole
  requestedAt: string
  requestedBy?: string
}

export type PipelineLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PipelineLogEvent {
  timestamp: string
  level: PipelineLogLevel
  event: string
  message: string
  runId: string
  role?: PipelineRole
  workerIndex?: number
  requirementId?: string
  taskId?: string
  repository?: string
  command?: string
  durationMs?: number
  retry?: number
  failureCode?: string
  metadata?: Record<string, unknown>
}

export interface PipelineLogFilter {
  role?: PipelineRole
  level?: PipelineLogLevel
  event?: string
  requirementId?: string
  taskId?: string
  repository?: string
  since?: string
  limit?: number
}

function emptyRoles(): PipelineRuntimeState['roles'] {
  return { executor: null, reviewer: null, merger: null }
}

function atomicWriteJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function parseJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function pipelineRunDirectory(root: string, runId: string) {
  if (!UUID_PATTERN.test(runId)) throw new Error(`Invalid pipeline run ID: ${runId}`)
  return join(resolve(root), runId)
}

export class PipelineRuntimeStore {
  readonly runDirectory: string
  readonly statePath: string
  readonly logPath: string
  readonly controlDirectory: string
  private state: PipelineRuntimeState

  constructor(
    private readonly config: DaemonPipelineConfig,
    plan: PipelineLaunchPlan,
    now: () => Date = () => new Date(),
  ) {
    this.runDirectory = pipelineRunDirectory(config.logging.directory, plan.runId)
    this.statePath = join(this.runDirectory, 'state.json')
    this.logPath = join(this.runDirectory, 'events.jsonl')
    this.controlDirectory = join(this.runDirectory, 'control')
    mkdirSync(this.controlDirectory, { recursive: true, mode: 0o700 })
    const timestamp = now().toISOString()
    const roles = emptyRoles()
    for (const launch of plan.roles) {
      roles[launch.role] = {
        role: launch.role,
        instanceId: launch.instanceId,
        status: 'starting',
        desiredState: 'running',
        pid: null,
        restartCount: 0,
        startedAt: null,
        stoppedAt: null,
        lastExitCode: null,
        lastSignal: null,
        lastFailureCode: null,
      }
    }
    this.state = {
      version: 1,
      runId: plan.runId,
      projectId: config.projectId,
      configPath: config.sourcePath,
      runMode: plan.runMode,
      supervisorPid: process.pid,
      status: 'starting',
      startedAt: timestamp,
      updatedAt: timestamp,
      stoppedAt: null,
      exitCode: null,
      roles,
    }
    this.persist()
  }

  snapshot() {
    return structuredClone(this.state)
  }

  updateRun(fields: Partial<Pick<PipelineRuntimeState, 'status' | 'stoppedAt' | 'exitCode'>>) {
    Object.assign(this.state, fields, { updatedAt: new Date().toISOString() })
    this.persist()
  }

  updateRole(role: PipelineRole, fields: Partial<PipelineRoleRuntimeState>) {
    const current = this.state.roles[role]
    if (!current) throw new Error(`Pipeline role '${role}' is not enabled for run ${this.state.runId}`)
    this.state.roles[role] = { ...current, ...fields }
    this.state.updatedAt = new Date().toISOString()
    this.persist()
  }

  append(event: Omit<PipelineLogEvent, 'timestamp' | 'runId'> & { timestamp?: string }) {
    const payload = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      runId: this.state.runId,
      ...event,
    }
    let line = `${JSON.stringify(payload)}\n`
    if (Buffer.byteLength(line) > this.config.logging.maxBytes) {
      const shortened = {
        ...payload,
        message: `${event.message.slice(0, Math.floor(this.config.logging.maxBytes / 4))}…`,
        metadata: { truncated: true },
      }
      line = `${JSON.stringify(shortened)}\n`
    }
    this.rotateIfNeeded(Buffer.byteLength(line))
    appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 })
  }

  takeControlCommands() {
    const commands: PipelineControlCommand[] = []
    if (!existsSync(this.controlDirectory)) return commands
    for (const name of readdirSync(this.controlDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(this.controlDirectory, name)
      try {
        commands.push(parseJsonFile<PipelineControlCommand>(path))
      } finally {
        rmSync(path, { force: true })
      }
    }
    return commands
  }

  private persist() {
    atomicWriteJson(this.statePath, this.state)
  }

  private rotateIfNeeded(incomingBytes: number) {
    const currentBytes = existsSync(this.logPath) ? statSync(this.logPath).size : 0
    if (currentBytes + incomingBytes <= this.config.logging.maxBytes) return
    if (this.config.logging.maxFiles === 1) {
      rmSync(this.logPath, { force: true })
      return
    }
    const last = `${this.logPath}.${this.config.logging.maxFiles - 1}`
    rmSync(last, { force: true })
    for (let index = this.config.logging.maxFiles - 2; index >= 1; index -= 1) {
      const source = `${this.logPath}.${index}`
      if (existsSync(source)) renameSync(source, `${this.logPath}.${index + 1}`)
    }
    if (existsSync(this.logPath)) renameSync(this.logPath, `${this.logPath}.1`)
  }
}

export function readPipelineState(root: string, runId: string) {
  const path = join(pipelineRunDirectory(root, runId), 'state.json')
  if (!existsSync(path)) throw new Error(`Pipeline run not found: ${runId}`)
  return parseJsonFile<PipelineRuntimeState>(path)
}

export function listPipelineStates(root: string) {
  const absoluteRoot = resolve(root)
  if (!existsSync(absoluteRoot)) return []
  return readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [readPipelineState(absoluteRoot, entry.name)]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

export function enqueuePipelineControl(
  root: string,
  runId: string,
  input: Omit<PipelineControlCommand, 'id' | 'requestedAt'>,
) {
  const state = readPipelineState(root, runId)
  if (state.status === 'stopped' || state.status === 'failed') {
    throw new Error(`Pipeline run ${runId} is already ${state.status}`)
  }
  if (input.role && !state.roles[input.role]) {
    throw new Error(`Pipeline role '${input.role}' is not enabled for run ${runId}`)
  }
  const command: PipelineControlCommand = {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...input,
  }
  const controlDirectory = join(pipelineRunDirectory(root, runId), 'control')
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(controlDirectory, `${command.requestedAt.replace(/[:.]/g, '-')}-${command.id}.json`), command)
  return command
}

function parseLogLines(path: string) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as PipelineLogEvent]
    } catch {
      return []
    }
  })
}

export function readPipelineLogs(root: string, runId: string, filter: PipelineLogFilter = {}) {
  const directory = pipelineRunDirectory(root, runId)
  if (!existsSync(join(directory, 'state.json'))) throw new Error(`Pipeline run not found: ${runId}`)
  const files = readdirSync(directory)
    .filter((name) => name === 'events.jsonl' || /^events\.jsonl\.\d+$/.test(name))
    .sort((left, right) => {
      if (left === 'events.jsonl') return 1
      if (right === 'events.jsonl') return -1
      return Number(right.split('.').at(-1)) - Number(left.split('.').at(-1))
    })
  const since = filter.since ? new Date(filter.since).getTime() : null
  if (since !== null && Number.isNaN(since)) throw new Error(`Invalid --since timestamp: ${filter.since}`)
  const limit = filter.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Log limit must be an integer from 1 to 10000')
  }
  const items = files.flatMap((file) => parseLogLines(join(directory, file))).filter((event) => {
    if (filter.role && event.role !== filter.role) return false
    if (filter.level && event.level !== filter.level) return false
    if (filter.event && event.event !== filter.event) return false
    if (filter.requirementId && event.requirementId !== filter.requirementId) return false
    if (filter.taskId && event.taskId !== filter.taskId) return false
    if (filter.repository && event.repository !== filter.repository) return false
    if (since !== null && new Date(event.timestamp).getTime() < since) return false
    return true
  })
  return items.slice(-limit)
}
