import { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../config.js'
import { runThinOnce } from '../thin-worker.js'
import { printJson } from '../output.js'
import { get, post, request } from '../client.js'
import { startThinWake } from '../thin-worker-wake.js'

export function registerThinWorker(program: Command) {
  const worker = program.command('worker').description('run one explicitly enabled task worker')
  worker.command('attempts').description('inspect recent task attempts and lease state')
    .requiredOption('--project <id>', 'project scope').action(async options => {
      printJson(await get(`/api/v1/thin-workers/attempts?${new URLSearchParams({ projectId: options.project })}`))
    })
  worker.command('presence').description('inspect recent worker liveness')
    .requiredOption('--project <id>', 'project scope').action(async options => {
      printJson(await get(`/api/v1/thin-workers/presence?${new URLSearchParams({ projectId: options.project })}`))
    })
  worker.command('mode').description('switch a drained project between worker modes')
    .requiredOption('--project <id>', 'project scope').requiredOption('--set <mode>', 'legacy or thin')
    .requiredOption('--inspection <text>', 'what was inspected before cutover').action(async options => {
      printJson(await post('/api/v1/thin-workers/mode', { projectId: options.project, mode: options.set, inspection: options.inspection }))
    })
  worker.command('resolve <attempt-id>').description('record a human decision for interrupted work')
    .requiredOption('--disposition <value>', 'review or retry').requiredOption('--reason <text>', 'inspection and decision')
    .option('--retry-safe', 'confirm that repeating the work is safe').action(async (attemptId, options) => {
      printJson(await post('/api/v1/thin-workers/resolve', { attemptId, disposition: options.disposition, reason: options.reason, retrySafe: Boolean(options.retrySafe) }))
    })
  worker.command('start').description('pull one task or remain available for scoped work')
    .requiredOption('--project <id>', 'project to serve')
    .requiredOption('--model <model>', 'Codex model')
    .option('--think <effort>', 'Codex reasoning effort', 'low')
    .option('--once', 'process at most one task')
    .option('--poll-seconds <seconds>', 'idle polling interval', '30')
    .option('--timeout-minutes <minutes>', 'maximum executor duration', '60')
    .action(async options => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.project)) throw new Error('A project UUID is required')
      if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.think)) throw new Error('Invalid Codex reasoning effort')
      const poll = Number(options.pollSeconds), timeout = Number(options.timeoutMinutes)
      if (!Number.isFinite(poll) || poll < 5 || poll > 3600 || !Number.isFinite(timeout) || timeout < 1 || timeout > 1440) throw new Error('Invalid worker polling or timeout interval')
      const controller = new AbortController()
      const stop = () => controller.abort(new Error('Worker interrupted'))
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      const config = loadConfig()
      if (!config.apiKey || !config.nodeId) throw new Error('Thin worker requires an API key and node identity')
      const workerId = randomUUID(), presence = { projectId: options.project, workerId, nodeId: config.nodeId }
      const credential = { apiUrl: config.apiUrl, apiKey: config.apiKey }
      const reportPresence = () => request('POST', '/api/v1/thin-workers/presence', presence, { credential, signal: AbortSignal.timeout(10000) })
      await reportPresence()
      let reporting: Promise<unknown> | undefined
      const presenceTimer = setInterval(() => {
        if (!reporting) reporting = reportPresence().catch(() => { console.warn('Worker presence heartbeat failed; current attempt lease is managed separately') }).finally(() => { reporting = undefined })
      }, 30000)
      const wake = options.once ? undefined : startThinWake({ apiUrl: config.apiUrl, apiKey: config.apiKey, projectId: options.project })
      try {
        do {
          const outcome = await runThinOnce({ config, projectId: options.project, model: options.model, effort: options.think, timeoutMs: timeout * 60000, signal: controller.signal, workerId })
          printJson(outcome)
          if (options.once && ['attention', 'cooldown'].includes(outcome.state)) process.exitCode = 1
          if (options.once || controller.signal.aborted) break
          const requested = outcome.state === 'cooldown' && outcome.retryAt ? Date.parse(outcome.retryAt) - Date.now() : outcome.state === 'cooldown' ? 15 * 60000 : poll * 1000
          const wait = Math.max(poll * 1000, Math.min(24 * 3600000, requested))
          if (outcome.state === 'cooldown') await delay(wait, undefined, { signal: controller.signal }).catch(() => undefined)
          else await wake!.wait(wait, controller.signal)
        } while (!controller.signal.aborted)
      } finally {
        clearInterval(presenceTimer)
        await reporting
        await wake?.close()
        await request('POST', '/api/v1/thin-workers/presence/stop', presence, { credential, signal: AbortSignal.timeout(3000) }).catch(() => undefined)
        process.off('SIGINT', stop); process.off('SIGTERM', stop)
      }
    })
}
