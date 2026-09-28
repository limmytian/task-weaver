import { spawn, type ChildProcess } from 'node:child_process'

export type CommandOutputStream = 'stdout' | 'stderr'

export interface CommandOutputEvent {
  stream: CommandOutputStream
  chunk: string
}

export interface AsyncCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string
  timeoutMs?: number
  killGraceMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  redact?: (value: string) => string
  onOutput?: (event: CommandOutputEvent) => void
}

export interface AsyncCommandResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  command: string
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  outputTruncated: boolean
  durationMs: number
  errorCode?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (limit === 0) return { value: Buffer.alloc(0), truncated: current.length > 0 || chunk.length > 0 }
  if (current.length + chunk.length <= limit) {
    return { value: Buffer.concat([current, chunk]), truncated: false }
  }
  const combined = Buffer.concat([current, chunk])
  return { value: combined.subarray(Math.max(0, combined.length - limit)), truncated: true }
}

function commandLabel(command: string, args: string[]) {
  return [command, ...args].join(' ')
}

function requestStop(child: ChildProcess, killGraceMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return undefined
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, killGraceMs)
  timer.unref()
  return timer
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: AsyncCommandOptions = {},
): Promise<AsyncCommandResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const maxOutputBytes = Math.max(0, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const redact = options.redact ?? ((value: string) => value)
  const label = commandLabel(command, args)

  if (options.signal?.aborted) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      command: label,
      signal: null,
      timedOut: false,
      cancelled: true,
      outputTruncated: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'ABORT_ERR',
    }
  }

  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let outputTruncated = false
    let timedOut = false
    let cancelled = false
    let spawnError: NodeJS.ErrnoException | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const emit = (stream: CommandOutputStream, chunk: Buffer) => {
      const text = redact(chunk.toString('utf8'))
      if (!text || !options.onOutput) return
      try {
        options.onOutput({ stream, chunk: text })
      } catch {
        // Observability hooks must never break command execution.
      }
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const appended = appendBounded(stdout, buffer, maxOutputBytes)
      stdout = appended.value
      outputTruncated ||= appended.truncated
      emit('stdout', buffer)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const appended = appendBounded(stderr, buffer, maxOutputBytes)
      stderr = appended.value
      outputTruncated ||= appended.truncated
      emit('stderr', buffer)
    })

    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killTimer = requestStop(child, killGraceMs)
        }, timeoutMs)
      : undefined
    timeout?.unref()

    const abort = () => {
      cancelled = true
      killTimer = requestStop(child, killGraceMs)
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error
    })

    child.on('close', (status, signal) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)

      const capturedStdout = redact(stdout.toString('utf8')).trim()
      const capturedStderr = redact(stderr.toString('utf8')).trim()
      const errorText = spawnError?.message ? redact(spawnError.message) : ''
      resolve({
        ok: status === 0 && !timedOut && !cancelled && !spawnError,
        status,
        stdout: capturedStdout,
        stderr: [capturedStderr, errorText].filter(Boolean).join('\n'),
        command: label,
        signal,
        timedOut,
        cancelled,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        ...(spawnError?.code ? { errorCode: spawnError.code } : {}),
      })
    })
  })
}
