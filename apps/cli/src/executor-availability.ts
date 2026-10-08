import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ExecutorFailure, ExecutorObservation, ExecutorTool } from '@task-weaver/contracts'

const reasons: Record<ExecutorFailure, string> = {
  rate_limited: 'Provider temporarily rate limited this executor.',
  quota_exhausted: 'Provider allowance is exhausted.',
  billing_blocked: 'Provider billing requires operator action.',
  auth_required: 'Executor authentication requires operator action.',
  unknown_failure: 'Executor failed without a confirmed resource signal.',
}
export function failureObservation(tool: ExecutorTool, profileId: string, failure: ExecutorFailure,
  source: ExecutorObservation['source'], now = new Date(), resetAt: string | null = null): ExecutorObservation {
  return { eventId: randomUUID(), tool, profileId, poolId: null, toolVersion: null, authenticationMode: 'unknown',
    state: failure === 'auth_required' || failure === 'billing_blocked' ? 'action_required' : failure === 'unknown_failure' ? 'unknown' : 'cooling_down',
    failure, source, confidence: source === 'structured_error' ? 'high' : source === 'text_error' ? 'low' : 'unknown',
    observedAt: now.toISOString(), staleAt: new Date(now.getTime() + 60_000).toISOString(), resetAt,
    retryAfterSeconds: null, reason: reasons[failure], windows: [] }
}
const codes: Record<string, ExecutorFailure> = {
  rate_limit_exceeded: 'rate_limited', rate_limit_error: 'rate_limited', rate_limit: 'rate_limited',
  usage_limit_reached: 'quota_exhausted', insufficient_quota: 'quota_exhausted', quota_exceeded: 'quota_exhausted',
  billing_hard_limit_reached: 'billing_blocked', billing_error: 'billing_blocked',
  authentication_error: 'auth_required', invalid_api_key: 'auth_required', unauthorized: 'auth_required',
};
/** Only top-level provider error envelopes are trusted, never model/tool message bodies. */
export function classifyExecutorLine(tool: ExecutorTool, line: string, stream: 'stdout' | 'stderr') {
  try {
    const event = JSON.parse(line)
    if (!['error', 'turn.failed', 'result'].includes(event.type)) return null
    if (event.type === 'result' && event.is_error !== true) return null
    const error = event.error
    const code = typeof error === 'object' ? error?.code ?? error?.type : event.code ?? event.subtype
    if (typeof code === 'string' && codes[code]) {
      const retry = error?.retry_after ?? event.retryAfterSeconds
      return { failure: codes[code], source: 'structured_error' as const, retryAfterSeconds: typeof retry === 'number' && retry >= 0 && retry <= 604800 ? retry : null }
    }
    // Codex exec can report only a message in a terminal error envelope.
    const message = typeof error === 'object' ? error?.message : typeof error === 'string' ? error : event.message
    if (typeof message === 'string') return classifyExecutorText(tool, message)
    return null
  } catch {
    return stream === 'stderr' ? classifyExecutorText(tool, line) : null
  }
}
function classifyExecutorText(tool: ExecutorTool, text: string) {
  // Anchored provider diagnostics only. Discussion, quoted code and HTTP 429 alone are not signals.
  if (tool === 'codex' && /^(?:error:\s*)?you(?:'|’)ve hit your usage limit\b/i.test(text)) return { failure: 'quota_exhausted' as const, source: 'text_error' as const }
  if (tool === 'claude' && /^(?:error:\s*)?you(?:'|’)ve hit your limit\b/i.test(text)) return { failure: 'quota_exhausted' as const, source: 'text_error' as const }
  if (/^(?:error:\s*)?(?:insufficient_quota|quota_exceeded):/i.test(text)) return { failure: 'quota_exhausted' as const, source: 'text_error' as const }
  if (/^(?:error:\s*)?(?:rate_limit_exceeded|rate_limit_error):/i.test(text)) return { failure: 'rate_limited' as const, source: 'text_error' as const }
  if (/^(?:error:\s*)?(?:billing_hard_limit_reached|billing_error):/i.test(text)) return { failure: 'billing_blocked' as const, source: 'text_error' as const }
  if (/^(?:error:\s*)?(?:authentication_error|invalid_api_key):/i.test(text)) return { failure: 'auth_required' as const, source: 'text_error' as const }
  return null
}
export class ExecutorSignalCollector {
  private buffers = { stdout: '', stderr: '' }
  private decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  private skipping = { stdout: false, stderr: false }
  observation: ExecutorObservation | null = null
  constructor(private tool: ExecutorTool, private profileId: string, private onBlocked?: (observation: ExecutorObservation) => void) {}
  push(stream: 'stdout' | 'stderr', chunk: Buffer) { this.consume(stream, this.decoders[stream].write(chunk)); if (!this.skipping[stream]) this.line(stream, this.buffers[stream].trim()) }
  private consume(stream: 'stdout' | 'stderr', text: string) {
    for (const part of text.split(/(?<=\n)/)) {
      if (this.skipping[stream]) { if (part.endsWith('\n')) this.skipping[stream] = false; continue }
      this.buffers[stream] += part
      if (Buffer.byteLength(this.buffers[stream]) > 64 * 1024) {
        this.buffers[stream] = ''; this.skipping[stream] = !part.endsWith('\n'); continue
      }
      if (part.endsWith('\n')) { this.line(stream, this.buffers[stream].trim()); this.buffers[stream] = '' }
    }
  }
  private line(stream: 'stdout' | 'stderr', line: string) {
    const signal = classifyExecutorLine(this.tool, line, stream)
    if (!signal || this.observation) return
    this.observation = failureObservation(this.tool, this.profileId, signal.failure, signal.source)
    if ('retryAfterSeconds' in signal) this.observation.retryAfterSeconds = signal.retryAfterSeconds ?? null
    this.onBlocked?.(this.observation)
  }
  finish() { for (const stream of ['stdout','stderr'] as const) { this.consume(stream, this.decoders[stream].end()); this.line(stream,this.buffers[stream].trim()) }; return this.observation }
}

export function parseCodexQuota(result: any, profileId: string, now = new Date()): ExecutorObservation {
  const windows: ExecutorObservation['windows'] = []
  const buckets = result.rateLimitsByLimitId ?? (result.rateLimits ? { [result.rateLimits.limitId ?? 'codex']: result.rateLimits } : {})
  for (const [bucket, value] of Object.entries(buckets).slice(0,32)) {
    for (const window of ['primary','secondary'] as const) {
      const w = (value as any)?.[window]
      if (!w) continue
      const percent = typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null
      const resetAt = Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0 && w.resetsAt < 253402300799 ? new Date(w.resetsAt * 1000).toISOString() : null
      windows.push({ bucket: bucket.slice(0,100), window, usedPercent: percent, remainingPercent: percent === null ? null : 100-percent,
        durationMinutes: Number.isSafeInteger(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null, resetAt })
    }
  }
  const exhausted = windows.filter(w => w.usedPercent === 100 && (!w.resetAt || Date.parse(w.resetAt) > now.getTime()))
  return { ...failureObservation('codex',profileId,'unknown_failure','status_query',now),
    source:'status_query', confidence:'high', authenticationMode:'subscription', failure: exhausted.length ? 'quota_exhausted' : null,
    state: exhausted.length ? 'cooling_down' : windows.length && windows.every(w=>w.usedPercent !== null && (!w.resetAt || Date.parse(w.resetAt) > now.getTime())) ? 'available' : 'unknown',
    resetAt: exhausted.length && exhausted.every(w=>w.resetAt) ? exhausted.map(w=>w.resetAt!).sort().at(-1)! : null,
    reason: exhausted.length ? reasons.quota_exhausted : windows.length ? 'Provider quota windows reported; model-to-bucket mapping is not assumed.' : 'Provider returned no quota windows.', windows }
}

/** Read-only JSON-RPC. No thread, turn, model prompt, credential scraping or reset-credit redemption. */
export async function queryCodexQuota(profileId: string, env = process.env, command = 'codex', timeoutMs = 8000): Promise<ExecutorObservation> {
  const observedAt = new Date()
  return new Promise(resolve => {
    const child = spawn(command,['app-server','--stdio'],{ env, stdio:['pipe','pipe','pipe'] })
    let settled = false, pending = '', total = 0
    const unknown = () => ({ ...failureObservation('codex',profileId,'unknown_failure','unsupported'), failure:null, reason:'Quota status unavailable or unsupported by this executor version/authentication mode.' })
    const finish = (value: ExecutorObservation) => { if (settled) return; settled=true; clearTimeout(timer); child.kill('SIGTERM'); const kill=setTimeout(()=>child.kill('SIGKILL'),1000); kill.unref(); child.once('close',()=>clearTimeout(kill)); resolve(value) }
    const timer = setTimeout(()=>finish(unknown()),timeoutMs)
    child.on('error',()=>finish(unknown())); child.on('close',()=>finish(unknown()))
    child.stdin.on('error',()=>finish(unknown()))
    child.stderr.on('data',()=>{ /* Never retain provider diagnostics or account identifiers. */ })
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value)+'\n')
    child.once('spawn',()=>send({id:1,method:'initialize',params:{clientInfo:{name:'task_weaver_quota',version:'0.3.4'}}}))
    child.stdout.on('data',(chunk: Buffer)=>{
      total += chunk.length; if (total > 512*1024) return finish(unknown())
      pending += chunk.toString('utf8')
      const lines=pending.split('\n'); pending=lines.pop()!
      for (const line of lines) { let value:any; try { value=JSON.parse(line) } catch { continue }
        if(value.id===1) { if(value.error) return finish(unknown()); send({method:'initialized'}); send({id:2,method:'account/rateLimits/read'}) }
        if(value.id===2) return finish(value.error ? unknown() : parseCodexQuota(value.result ?? {},profileId,observedAt))
      }
    })
  })
}

export class ExecutorResourceBlocked extends Error {
  constructor(readonly observation: ExecutorObservation) { super(observation.reason); this.name = 'ExecutorResourceBlocked' }
}
