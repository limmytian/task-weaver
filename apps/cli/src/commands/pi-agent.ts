import { Command, Option } from 'commander'
import { spawn } from 'node:child_process'
import { buildPiAgentRunPrompt } from '@task-weaver/partners-gateway'
import { get, post, put } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, signal: null, stdout, stderr: error.message })
    })
  })
}

function toTiDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toTiDisplay)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => {
      const displayKey = key
        .replace(/Pi/g, '')
        .replace(/^piSessionId$/, 'sessionId')
      return [displayKey, toTiDisplay(fieldValue)]
    }),
  )
}

export function registerPiAgent(program: Command): void {
  const pi = program.command('ti').description('manage Ti server agent configuration and runs')

  const config = pi.command('config').description('manage Ti provider/model configs')

  config
    .command('list')
    .description('list Ti model configs for the current actor')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--include-disabled', 'include disabled configs')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.ownerId) params.set('ownerId', opts.ownerId)
      if (opts.ownerType) params.set('ownerType', opts.ownerType)
      if (opts.includeDisabled) params.set('includeDisabled', 'true')
      const qs = params.toString() ? `?${params}` : ''
      const data = await get(`/api/v1/pi-agent/configs${qs}`)
      if (opts.json) return printJson(data)
      printTable(data as Record<string, unknown>[], ['id', 'provider', 'model', 'enabled', 'credentialStatus', 'isDefault'])
    })

  config
    .command('upsert')
    .description('create or update a Ti model config')
    .requiredOption('--provider <provider>', 'Ti provider id')
    .requiredOption('--model <model>', 'Ti model id')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--label <label>', 'display label')
    .option('--api-key-ref <ref>', 'credential reference, never raw secret material')
    .option('--credential-status <status>', 'unknown|valid|invalid|missing', 'unknown')
    .option('--disabled', 'disable this model config')
    .option('--default', 'set as default model for owner')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/pi-agent/configs', {
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        provider: opts.provider,
        model: opts.model,
        label: opts.label,
        apiKeyRef: opts.apiKeyRef,
        credentialStatus: opts.credentialStatus,
        enabled: !opts.disabled,
        isDefault: Boolean(opts.default),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  config
    .command('default <configId>')
    .description('set a Ti model config as the owner default')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--json', 'output raw JSON')
    .action(async (configId, opts) => {
      const data = await post('/api/v1/pi-agent/configs/default', {
        configId,
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  pi
    .command('resolve-model')
    .description('resolve requested Ti provider/model with default fallback')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--provider <provider>', 'requested Ti provider')
    .option('--model <model>', 'requested Ti model')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/pi-agent/resolve-model', {
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        requestedPiProvider: opts.provider,
        requestedPiModel: opts.model,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const policy = pi.command('policy').description('manage Ti agent execution policy')

  policy
    .command('get')
    .description('show Ti agent policy for the current actor')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.ownerId) params.set('ownerId', opts.ownerId)
      if (opts.ownerType) params.set('ownerType', opts.ownerType)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get(`/api/v1/pi-agent/policy${qs}`)
      if (opts.json) return printJson(data)
      printKv((data ?? {}) as Record<string, unknown>)
    })

  policy
    .command('set')
    .description('set Ti agent execution policy')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--enabled', 'enable worker acquisition')
    .option('--mode <mode>', 'disabled|dry_run|live', 'disabled')
    .option('--max-concurrent <n>', 'maximum concurrent runs', '1')
    .option('--daily-limit <n>', 'daily run limit', '25')
    .option('--monthly-limit <n>', 'monthly run limit', '500')
    .option('--timeout <seconds>', 'run timeout seconds', '600')
    .option('--default-retries <n>', 'default max retries', '0')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await put('/api/v1/pi-agent/policy', {
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        enabled: Boolean(opts.enabled),
        executionMode: opts.mode,
        maxConcurrentRuns: Number(opts.maxConcurrent),
        dailyRunLimit: Number(opts.dailyLimit),
        monthlyRunLimit: Number(opts.monthlyLimit),
        runTimeoutSeconds: Number(opts.timeout),
        defaultMaxRetries: Number(opts.defaultRetries),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const runs = pi.command('run').description('manage queued Ti agent runs')

  runs
    .command('list')
    .description('list Ti agent runs')
    .option('--task <id>', 'task id')
    .option('--schedule-run <id>', 'schedule run id')
    .option('--assigned-agent <id>', 'assigned agent id')
    .option('--status <status>', 'queued|running|succeeded|failed|in_review|cancelled')
    .option('--limit <n>', 'maximum runs', '50')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.task) params.set('taskId', opts.task)
      if (opts.scheduleRun) params.set('scheduleRunId', opts.scheduleRun)
      if (opts.assignedAgent) params.set('assignedAgentId', opts.assignedAgent)
      if (opts.status) params.set('status', opts.status)
      if (opts.limit) params.set('limit', opts.limit)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get(`/api/v1/pi-agent/runs${qs}`)
      if (opts.json) return printJson(data)
      const rows = (data as Record<string, unknown>[]).map((run) => ({
        id: run.id,
        status: run.status,
        taskId: run.taskId,
        scheduleRunId: run.scheduleRunId,
        actualProvider: run.actualPiProvider,
        actualModel: run.actualPiModel,
      }))
      printTable(rows, ['id', 'status', 'taskId', 'scheduleRunId', 'actualProvider', 'actualModel'])
    })

  runs
    .command('create')
    .description('queue an explicitly assigned Ti agent run')
    .option('--task <id>', 'task id')
    .option('--schedule-run <id>', 'schedule run id')
    .option('--assigned-agent <id>', 'assigned agent id', 'task-weaver:ti-agent')
    .option('--provider <provider>', 'requested Ti provider')
    .option('--model <model>', 'requested Ti model')
    .option('--max-retries <n>', 'maximum retries')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const body: Record<string, unknown> = {
        taskId: opts.task,
        scheduleRunId: opts.scheduleRun,
        assignedAgentId: opts.assignedAgent,
        assignedAgentType: 'agent',
        requestedPiProvider: opts.provider,
        requestedPiModel: opts.model,
      }
      if (opts.maxRetries !== undefined) body.maxRetries = Number(opts.maxRetries)
      const data = await post('/api/v1/pi-agent/runs', body)
      if (opts.json) return printJson(data)
      printKv(toTiDisplay(data) as Record<string, unknown>)
    })

  runs
    .command('get <id>')
    .description('get a Ti agent run with target details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/pi-agent/runs/${id}`)
      if (opts.json) return printJson(data)
      printKv(toTiDisplay(data) as Record<string, unknown>)
    })

  runs
    .command('acquire')
    .description('lease the next queued Ti agent run')
    .requiredOption('--worker <id>', 'worker id')
    .option('--assigned-agent <id>', 'assigned agent id', 'task-weaver:ti-agent')
    .option('--duration <minutes>', 'lease duration minutes', '15')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/pi-agent/runs/acquire', {
        workerId: opts.worker,
        assignedAgentId: opts.assignedAgent,
        durationMinutes: Number(opts.duration),
      })
      if (opts.json) return printJson(data)
      printKv(toTiDisplay(data ?? {}) as Record<string, unknown>)
    })

  runs
    .command('complete <id>')
    .description('complete a Ti agent run after execution')
    .requiredOption('--status <status>', 'succeeded|failed|in_review|cancelled')
    .option('--actual-provider <provider>', 'actual Ti provider')
    .option('--actual-model <model>', 'actual Ti model')
    .option('--session <id>', 'Ti session id')
    .option('--summary <text>', 'output summary')
    .option('--error <text>', 'error message')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/pi-agent/runs/${id}/complete`, {
        status: opts.status,
        actualPiProvider: opts.actualProvider,
        actualPiModel: opts.actualModel,
        piSessionId: opts.session,
        outputSummary: opts.summary,
        errorMessage: opts.error,
      })
      if (opts.json) return printJson(data)
      printKv(toTiDisplay(data) as Record<string, unknown>)
    })

  const worker = pi.command('worker').description('run the bounded Ti agent worker')

  worker
    .command('status')
    .description('show API-side Partners Gateway worker status')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get('/api/v1/pi-agent/worker/status')
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  worker
    .command('health')
    .description('check Partners Gateway connectivity')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get('/api/v1/pi-agent/worker/health')
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  worker
    .command('run-once')
    .description('acquire and execute one queued Ti agent run')
    .requiredOption('--worker <id>', 'worker id')
    .option('--assigned-agent <id>', 'assigned agent id', 'task-weaver:ti-agent')
    .option('--duration <minutes>', 'lease duration minutes', '15')
    .option('--executor-command <command>', 'Ti executor command')
    .addOption(new Option('--pi-command <command>').hideHelp())
    .option('--dry-run', 'complete without invoking Ti')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const acquired: any = await post('/api/v1/pi-agent/runs/acquire', {
        workerId: opts.worker,
        assignedAgentId: opts.assignedAgent,
        durationMinutes: Number(opts.duration),
      })
      if (!acquired) {
        if (opts.json) return printJson({ run: null })
        console.log('No queued Ti agent runs')
        return
      }

      const run: any = await get(`/api/v1/pi-agent/runs/${acquired.id}`)
      const policy: any = await get('/api/v1/pi-agent/policy')
      const prompt = buildPiAgentRunPrompt(run)
      if (opts.dryRun || policy?.executionMode === 'dry_run') {
        const completed = await post(`/api/v1/pi-agent/runs/${run.id}/complete`, {
          status: 'in_review',
          outputSummary: `Dry-run worker acquired ${run.id}; Ti was not invoked.`,
        })
        if (opts.json) return printJson({ run, completed })
        printKv(toTiDisplay(completed) as Record<string, unknown>)
        return
      }

      const args = ['--mode', 'json']
      if (run.actualPiProvider) args.push('--provider', run.actualPiProvider)
      if (run.actualPiModel) args.push('--model', run.actualPiModel)
      args.push(prompt)
      const executorCommand = opts.piCommand ?? opts.executorCommand ?? 'pi'
      const result = await runCommand(executorCommand, args, Number(opts.duration) * 60_000)
      const succeeded = result.code === 0
      const completed = await post(`/api/v1/pi-agent/runs/${run.id}/complete`, {
        status: succeeded ? 'succeeded' : 'failed',
        actualPiProvider: run.actualPiProvider,
        actualPiModel: run.actualPiModel,
        eventLog: result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) } catch { return { raw: line } }
          }),
        outputSummary: succeeded ? result.stdout.slice(-4000) : undefined,
        errorMessage: succeeded ? undefined : (result.stderr || result.stdout).slice(-4000),
      })
      if (opts.json) return printJson({ run, completed, result })
      printKv(toTiDisplay(completed) as Record<string, unknown>)
    })
}
