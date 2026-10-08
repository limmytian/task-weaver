import { ExecutorSignalCollector } from './executor-availability.js'
import { executorToolSchema, type ExecutorObservation } from '@task-weaver/contracts'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  agentUsageSummarySchema,
  type AgentUsageSummary,
  type ReportAgentUsageInput,
} from '@task-weaver/contracts'
import {
  runCommand,
  type AsyncCommandOptions,
  type AsyncCommandResult,
} from './async-command.js'
import { request } from './client.js'

export function unknownUsage(): AgentUsageSummary {
  return agentUsageSummarySchema.parse({ completeness: 'unknown' })
}

/** Codex exec emits cumulative thread totals; snapshots replace, never add. */
export class CodexUsageCollector {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private skipping = false
  private incomplete = false
  private completed = false
  private summary = unknownUsage()
  private readonly maxLineBytes = 1024 * 1024

  push(chunk: Buffer) {
    this.consume(this.decoder.write(chunk))
  }
  private consume(chunk: string) {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (this.skipping) {
        if (part.endsWith('\n')) this.skipping = false
        continue
      }
      this.pending += part
      if (Buffer.byteLength(this.pending) > this.maxLineBytes) {
        this.pending = ''
        this.skipping = !part.endsWith('\n')
        this.incomplete = true
      } else if (part.endsWith('\n')) {
        this.line(this.pending.trim())
        this.pending = ''
      }
    }
  }
  private line(line: string) {
    if (!line) return
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      this.incomplete = true
      return
    }
    if (event?.type === 'turn.failed' || event?.type === 'error')
      this.incomplete = true
    if (event?.type === 'turn.started') this.completed = false
    if (event?.type !== 'turn.completed') return
    const usage = event.usage
    const parsed = agentUsageSummarySchema.safeParse({
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadTokens: usage?.cached_input_tokens,
      // Older Codex versions do not expose cache writes. Absence is not zero.
      cacheWriteTokens: usage?.cache_write_input_tokens ?? null,
      cacheSemantics: 'included',
      provider: 'unknown',
      model: 'unknown',
      completeness: 'complete',
    })
    let next: AgentUsageSummary
    if (parsed.success) {
      next = parsed.data
    } else {
      this.incomplete = true
      // Preserve independently valid reported counters when an event is incomplete.
      const validCounter = (value: unknown): number | null =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? value
          : null
      const inputTokens = validCounter(usage?.input_tokens)
      const cacheReadTokens = validCounter(usage?.cached_input_tokens)
      const recovered = agentUsageSummarySchema.safeParse({
        inputTokens,
        outputTokens: validCounter(usage?.output_tokens),
        cacheReadTokens:
          inputTokens !== null &&
          cacheReadTokens !== null &&
          cacheReadTokens > inputTokens
            ? null
            : cacheReadTokens,
        cacheWriteTokens: validCounter(usage?.cache_write_input_tokens),
        cacheSemantics: 'included',
        provider: 'unknown',
        model: 'unknown',
        completeness: 'partial',
      })
      if (!recovered.success) return
      next = recovered.data
    }
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const) {
      const prior = this.summary[key]
      if (prior !== null && (next[key] === null || next[key]! < prior)) {
        next[key] = prior
        this.incomplete = true
      }
    }
    this.summary = next
    this.completed = true
  }
  snapshot(succeeded = false): AgentUsageSummary {
    return {
      ...this.summary,
      completeness:
        this.summary.completeness === 'unknown'
          ? 'unknown'
          : succeeded && this.completed && !this.incomplete
            ? 'complete'
            : 'partial',
    }
  }
  finish(succeeded: boolean) {
    this.consume(this.decoder.end())
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
    return this.snapshot(succeeded)
  }
}

type Scope = Pick<
  ReportAgentUsageInput,
  'daemonId' | 'projectId' | 'requirementId' | 'phase' | 'agent' | 'runId' | 'leaseGeneration' | 'workerIndex'
>
export async function runMeteredAgent(
  command: string,
  argv: string[],
  options: AsyncCommandOptions,
  scope: Scope,
  report: (body: ReportAgentUsageInput) => Promise<unknown> = (body) =>
    request('POST', '/api/v1/agent-usage/runs', body, {
      signal: AbortSignal.timeout(2_500),
    }),
  availability?: { profileId: string; onObservation: (observation: ExecutorObservation) => Promise<unknown> },
): Promise<AsyncCommandResult & { resourceInterruption?: ExecutorObservation }> {
  if (options.signal?.aborted) return runCommand(command, argv, options)
  const observedAt = new Date()
  const processId = randomUUID()
  const interrupt = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, interrupt.signal]) : interrupt.signal
  const tool = executorToolSchema.safeParse(scope.agent)
  const detector = availability && tool.success ? new ExecutorSignalCollector(tool.data, availability.profileId, () => interrupt.abort('executor_resource_blocked')) : null
  let startedAt = new Date().toISOString()
  let launched = false
  const collector = scope.agent === 'codex' ? new CodexUsageCollector() : null
  let revision = 0
  let lastFlush = Date.now()
  let inFlight = Promise.resolve()
  let flushing = false
  let warned = false
  const flush = async (
    summary: AgentUsageSummary,
    outcome: ReportAgentUsageInput['outcome'],
    endedAt: string | null,
  ) => {
    const body = {
      ...scope,
      processId,
      startedAt,
      revision: revision++,
      summary,
      outcome,
      endedAt,
    }
    try {
      await report(body)
    } catch {
      // Collection outages must not alter execution results or print response bodies.
      if (!warned)
        console.warn(
          '[Daemon] Agent usage report could not be saved; accounting coverage may be incomplete.',
        )
      warned = true
    }
  }
  const result = await runCommand(command, argv, {
    ...options,
    signal,
    onStderr: (chunk) => { detector?.push('stderr', chunk); options.onStderr?.(chunk) },
    onSpawn: () => {
      launched = true
      startedAt = new Date().toISOString()
      flushing = true
      inFlight = flush(unknownUsage(), 'running', null).finally(() => {
        flushing = false
      })
      options.onSpawn?.()
    },
    onStdout: (chunk) => {
      detector?.push('stdout', chunk)
      collector?.push(chunk)
      options.onStdout?.(chunk)
      if (!flushing && Date.now() - lastFlush >= 5_000) {
        lastFlush = Date.now()
        const summary = collector?.snapshot() ?? unknownUsage()
        flushing = true
        inFlight = flush(summary, 'running', null).finally(() => {
          flushing = false
        })
      }
    },
  })
  const resourceInterruption = detector?.finish() ?? undefined
  if (resourceInterruption && availability) await availability.onObservation(resourceInterruption)
  if (!resourceInterruption && result.ok && availability && tool.success) await availability.onObservation({
    eventId: randomUUID(), tool: tool.data, profileId: availability.profileId, poolId: null, toolVersion: null, authenticationMode: 'unknown',
    state: 'available', failure: null, source: 'execution_success', confidence: 'high', observedAt: observedAt.toISOString(),
    staleAt: new Date(observedAt.getTime()+60_000).toISOString(), resetAt: null, retryAfterSeconds: null,
    reason: 'Executor completed a process successfully. Remaining subscription allowance is unknown.', windows: [],
  })
  const endedAt = new Date().toISOString()
  if (!launched) return result
  await inFlight
  await flush(
    collector?.finish(result.ok) ?? unknownUsage(),
    result.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed',
    endedAt,
  )
  return resourceInterruption ? { ...result, ok: false, cancelled: false, resourceInterruption } : result
}
