import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  PIPELINE_MODEL_TIERS,
  PIPELINE_ROLES,
  PipelineConfigError,
  type DaemonPipelineConfig,
  type PipelineRole,
  type PipelineRunMode,
} from './daemon-pipeline-config.js'
import {
  PipelineRuntimeStore,
  type PipelineControlCommand,
  type PipelineLogEvent,
  type PipelineRoleDesiredState,
} from './daemon-pipeline-store.js'

export interface PipelineRoleLaunch {
  role: PipelineRole
  instanceId: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface PipelineLaunchPlan {
  runId: string
  runMode: PipelineRunMode
  roles: PipelineRoleLaunch[]
}

export function formatPipelineHealth(
  launches: PipelineRoleLaunch[],
  active: ReadonlyMap<PipelineRole, ChildProcess>,
  restarts: ReadonlyMap<PipelineRole, number>,
) {
  return launches.map((launch) => {
    const child = active.get(launch.role)
    const state = child && child.exitCode === null && child.signalCode === null ? 'running' : 'stopped'
    const pid = child?.pid ? ` pid=${child.pid}` : ''
    const restartCount = restarts.get(launch.role) ?? 0
    return `${launch.role}=${state}${pid} restarts=${restartCount}`
  }).join(', ')
}

export interface BuildPipelinePlanOptions {
  runId?: string
  runMode?: PipelineRunMode
  entrypoint?: string
  runtimeCommand?: string
  runtimeArgs?: string[]
  environment?: NodeJS.ProcessEnv
  generateId?: () => string
}

function appendRepeated(args: string[], flag: string, values: string[]) {
  for (const value of values) args.push(flag, value)
}

function appendModelOptions(
  args: string[],
  flag: '--model' | '--think',
  values: Partial<Record<(typeof PIPELINE_MODEL_TIERS)[number], string>>,
) {
  for (const tier of PIPELINE_MODEL_TIERS) {
    const value = values[tier]
    if (value) args.push(flag, `${tier}:${value}`)
  }
}

export function resolvePipelineEnvironment(
  config: DaemonPipelineConfig,
  source: NodeJS.ProcessEnv = process.env,
) {
  const environment: NodeJS.ProcessEnv = { ...source }
  const missing: string[] = []
  for (const [target, reference] of Object.entries(config.environment)) {
    const value = source[reference.fromEnv]
    if (value === undefined || value === '') {
      if (reference.required) missing.push(`${target} (from ${reference.fromEnv})`)
      delete environment[target]
    } else {
      environment[target] = value
    }
  }
  if (missing.length > 0) {
    throw new PipelineConfigError([`required environment references are missing: ${missing.join(', ')}`])
  }
  return environment
}

export function buildPipelineRoleArgs(
  config: DaemonPipelineConfig,
  role: PipelineRole,
  instanceId: string,
) {
  const common = ['daemon', role === 'executor' ? 'start' : role === 'reviewer' ? 'review' : 'merge']
  const args = [...common, '--project', config.projectId, '--id', instanceId, '--workers', String(config.roles[role].workers)]

  if (role === 'executor') {
    const executor = config.roles.executor
    if (executor.tools.length > 0) args.push('--tools', executor.tools.join(','))
    if (executor.capabilities.length > 0) args.push('--capabilities', executor.capabilities.join(','))
    if (executor.queueMode) args.push('--mode', executor.queueMode)
    appendModelOptions(args, '--model', executor.models)
    appendModelOptions(args, '--think', executor.reasoningEffort)
    appendRepeated(args, '--prompt', executor.prompts)
    appendRepeated(args, '--prompt-file', executor.promptFiles)
  } else if (role === 'reviewer') {
    const reviewer = config.roles.reviewer
    args.push('--base', config.baseBranch)
    if (reviewer.tools.length > 0) args.push('--tools', reviewer.tools.join(','))
    appendModelOptions(args, '--model', reviewer.models)
    appendModelOptions(args, '--think', reviewer.reasoningEffort)
    appendRepeated(args, '--check', reviewer.checks)
    appendRepeated(args, '--prompt', reviewer.prompts)
    appendRepeated(args, '--prompt-file', reviewer.promptFiles)
    if (reviewer.skipAiReview) args.push('--skip-ai-review')
    if (reviewer.allowUnreviewed) args.push('--allow-unreviewed')
    if (reviewer.postForgeSummary) args.push('--post-forge-summary')
  } else {
    args.push('--base', config.baseBranch)
    args.push('--mode', config.mergePolicy.mode)
  }
  return args
}

export function buildPipelineLaunchPlan(
  config: DaemonPipelineConfig,
  options: BuildPipelinePlanOptions = {},
): PipelineLaunchPlan {
  const generateId = options.generateId ?? randomUUID
  const runId = options.runId ?? generateId()
  const runMode = options.runMode ?? config.runMode
  const entrypoint = options.entrypoint ?? process.argv[1]
  if (!entrypoint) throw new Error('Could not determine the Task Weaver CLI entrypoint')
  const runtimeCommand = options.runtimeCommand ?? process.execPath
  const runtimeArgs = options.runtimeArgs ?? process.execArgv
  const environment = resolvePipelineEnvironment(config, options.environment)
  const roles = PIPELINE_ROLES
    .filter((role) => config.roles[role].enabled)
    .map((role): PipelineRoleLaunch => {
      const instanceId = generateId()
      return {
        role,
        instanceId,
        command: runtimeCommand,
        args: [...runtimeArgs, entrypoint, ...buildPipelineRoleArgs(config, role, instanceId)],
        env: {
          ...environment,
          TW_DAEMON_PIPELINE_RUN_ID: runId,
          TW_DAEMON_PIPELINE_ROLE: role,
          TW_DAEMON_PIPELINE_MODE: runMode,
        },
      }
    })
  return { runId, runMode, roles }
}

export interface RunPipelineOptions {
  cwd?: string
  spawnChild?: typeof spawn
  log?: (message: string) => void
  store?: PipelineRuntimeStore
}

function waitForChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once('close', () => resolve()))
}

export async function runDaemonPipeline(
  config: DaemonPipelineConfig,
  plan: PipelineLaunchPlan,
  options: RunPipelineOptions = {},
) {
  const spawnChild = options.spawnChild ?? spawn
  const log = options.log ?? console.log
  const store = options.store
  const active = new Map<PipelineRole, ChildProcess>()
  const restarts = new Map<PipelineRole, number>()
  const desiredStates = new Map<PipelineRole, PipelineRoleDesiredState>(
    plan.roles.map((launch) => [launch.role, 'running']),
  )
  const operatorRestarts = new Set<PipelineRole>()
  const roleStartedAt = new Map<PipelineRole, number>()
  let stopping = false
  let resolveCompletion!: (exitCode: number) => void
  const completion = new Promise<number>((resolve) => { resolveCompletion = resolve })
  const restartTimers = new Set<ReturnType<typeof setTimeout>>()
  let controlTimer: ReturnType<typeof setInterval> | null = null
  const emit = (
    event: string,
    message: string,
    fields: Partial<Omit<PipelineLogEvent, 'timestamp' | 'runId' | 'event' | 'message'>> = {},
  ) => {
    log(`[Pipeline] ${message}`)
    store?.append({ event, message, level: fields.level ?? 'info', ...fields })
  }
  const reportHealth = () => {
    emit('pipeline_health', `Health: ${formatPipelineHealth(plan.roles, active, restarts)}`)
  }

  const stopChildren = async (reason: string, exitCode: number) => {
    if (stopping) return
    stopping = true
    store?.updateRun({ status: 'draining' })
    emit('pipeline_draining', `${reason}; draining ${active.size} role process(es).`, {
      level: exitCode === 0 ? 'info' : 'error',
      ...(exitCode === 0 ? {} : { failureCode: 'pipeline_failed' }),
    })
    if (controlTimer) clearInterval(controlTimer)
    for (const timer of restartTimers) clearTimeout(timer)
    restartTimers.clear()
    for (const child of active.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    const forceTimer = setTimeout(() => {
      for (const child of active.values()) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }, config.limits.shutdownGraceMs)
    forceTimer.unref()
    await Promise.allSettled([...active.values()].map(waitForChild))
    clearTimeout(forceTimer)
    active.clear()
    const stoppedAt = new Date().toISOString()
    store?.updateRun({
      status: exitCode === 0 ? 'stopped' : 'failed',
      stoppedAt,
      exitCode,
    })
    emit('pipeline_stopped', `Run ${plan.runId} stopped with exit code ${exitCode}.`, {
      level: exitCode === 0 ? 'info' : 'error',
      ...(exitCode === 0 ? {} : { failureCode: 'pipeline_failed' }),
    })
    resolveCompletion(exitCode)
  }

  const startRole = (launch: PipelineRoleLaunch) => {
    if (stopping) return
    desiredStates.set(launch.role, 'running')
    store?.updateRole(launch.role, {
      status: 'starting',
      desiredState: 'running',
      pid: null,
      stoppedAt: null,
    })
    emit('role_starting', `Starting ${launch.role} instance ${launch.instanceId}.`, {
      role: launch.role,
      command: [launch.command, ...launch.args].join(' '),
      retry: restarts.get(launch.role) ?? 0,
    })
    const child = spawnChild(launch.command, launch.args, {
      cwd: options.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active.set(launch.role, child)
    roleStartedAt.set(launch.role, Date.now())
    store?.updateRole(launch.role, {
      status: 'running',
      desiredState: 'running',
      pid: child.pid ?? null,
      restartCount: restarts.get(launch.role) ?? 0,
      startedAt: new Date().toISOString(),
      lastFailureCode: null,
    })
    const forwardOutput = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString()
      const target = stream === 'stdout' ? process.stdout : process.stderr
      target.write(text)
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const workerMatch = line.match(/Worker\s+(\d+)/i)
        const requirementMatch = line.match(/requirement(?:\s+lane)?[^0-9a-f]*([0-9a-f]{8}-[0-9a-f-]{27,})/i)
        const taskMatch = line.match(/task[^0-9a-f]*([0-9a-f]{8}-[0-9a-f-]{27,})/i)
        store?.append({
          event: 'role_output',
          level: stream === 'stderr' ? 'warn' : 'info',
          message: line,
          role: launch.role,
          command: [launch.command, ...launch.args].join(' '),
          ...(workerMatch?.[1] ? { workerIndex: Number(workerMatch[1]) } : {}),
          ...(requirementMatch?.[1] ? { requirementId: requirementMatch[1] } : {}),
          ...(taskMatch?.[1] ? { taskId: taskMatch[1] } : {}),
        })
      }
    }
    child.stdout?.on('data', (chunk: Buffer | string) => forwardOutput('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => forwardOutput('stderr', chunk))
    reportHealth()
    child.once('error', (error) => {
      emit('role_spawn_failed', `${launch.role} failed to start: ${error.message}`, {
        role: launch.role,
        level: 'error',
        failureCode: 'role_spawn_failed',
      })
    })
    child.once('close', (status, signal) => {
      active.delete(launch.role)
      const durationMs = Date.now() - (roleStartedAt.get(launch.role) ?? Date.now())
      const desiredState = desiredStates.get(launch.role) ?? 'running'
      const failureCode = status === 0 || desiredState !== 'running' || operatorRestarts.has(launch.role)
        ? undefined
        : `role_exit_${status ?? signal ?? 'unknown'}`
      store?.updateRole(launch.role, {
        status: desiredState === 'paused' ? 'paused' : desiredState === 'stopped' ? 'stopped' : status === 0 ? 'stopped' : 'failed',
        desiredState,
        pid: null,
        stoppedAt: new Date().toISOString(),
        lastExitCode: status,
        lastSignal: signal,
        lastFailureCode: failureCode ?? null,
      })
      emit('role_exited', `${launch.role} exited (${status ?? signal ?? 'unknown'}).`, {
        role: launch.role,
        durationMs,
        level: failureCode ? 'error' : 'info',
        ...(failureCode ? { failureCode } : {}),
      })
      reportHealth()
      if (stopping) return
      if (desiredState !== 'running') return
      if (operatorRestarts.delete(launch.role)) {
        startRole(launch)
        return
      }
      const attempt = (restarts.get(launch.role) ?? 0) + 1
      if (attempt > config.retry.maxRestarts) {
        void stopChildren(
          `${launch.role} exited (${status ?? signal ?? 'unknown'}) and exhausted ${config.retry.maxRestarts} restart(s)`,
          status && status > 0 ? status : 1,
        )
        return
      }
      restarts.set(launch.role, attempt)
      store?.updateRole(launch.role, { restartCount: attempt })
      const delay = Math.min(
        config.retry.maxBackoffMs,
        config.retry.initialBackoffMs * (2 ** Math.max(0, attempt - 1)),
      )
      emit('role_restart_scheduled', `${launch.role} restart ${attempt}/${config.retry.maxRestarts} in ${delay}ms.`, {
        role: launch.role,
        level: 'warn',
        retry: attempt,
        failureCode: failureCode ?? 'role_exit',
      })
      const timer = setTimeout(() => {
        restartTimers.delete(timer)
        startRole(launch)
      }, delay)
      restartTimers.add(timer)
    })
  }

  const applyControl = (command: PipelineControlCommand) => {
    const launches = command.role
      ? plan.roles.filter((launch) => launch.role === command.role)
      : plan.roles
    if (launches.length === 0) {
      emit('control_rejected', `Control ${command.action} rejected: role is not enabled.`, {
        level: 'warn',
        failureCode: 'role_not_enabled',
      })
      return
    }
    emit('control_received', `Applying ${command.action}${command.role ? ` to ${command.role}` : ' to all roles'}.`, {
      ...(command.role ? { role: command.role } : {}),
      metadata: { commandId: command.id, requestedBy: command.requestedBy },
    })
    if (command.action === 'stop' && !command.role) {
      void stopChildren('operator stop requested', 0)
      return
    }
    for (const launch of launches) {
      const child = active.get(launch.role)
      if (command.action === 'resume') {
        desiredStates.set(launch.role, 'running')
        store?.updateRole(launch.role, { desiredState: 'running' })
        if (!child) startRole(launch)
        continue
      }
      if (command.action === 'restart') {
        desiredStates.set(launch.role, 'running')
        operatorRestarts.add(launch.role)
        store?.updateRole(launch.role, { desiredState: 'running', status: child ? 'draining' : 'starting' })
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        else {
          operatorRestarts.delete(launch.role)
          startRole(launch)
        }
        continue
      }
      const desiredState: PipelineRoleDesiredState = command.action === 'pause' ? 'paused' : 'stopped'
      desiredStates.set(launch.role, desiredState)
      store?.updateRole(launch.role, {
        desiredState,
        status: child ? 'draining' : desiredState === 'paused' ? 'paused' : 'stopped',
      })
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
  }

  const onSignal = (signal: NodeJS.Signals) => {
    void stopChildren(`${signal} received`, 0)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  store?.updateRun({ status: 'running' })
  emit('pipeline_started', `Run ${plan.runId} starting in ${plan.runMode} mode with ${plan.roles.length} role(s).`)
  for (const launch of plan.roles) startRole(launch)
  if (store) {
    controlTimer = setInterval(() => {
      try {
        for (const command of store.takeControlCommands()) applyControl(command)
      } catch (error) {
        emit('control_failed', error instanceof Error ? error.message : String(error), {
          level: 'error',
          failureCode: 'control_processing_failed',
        })
      }
    }, config.limits.controlPollMs)
  }
  const exitCode = await completion
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  return exitCode
}
