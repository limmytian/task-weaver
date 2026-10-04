import { Command } from 'commander'
import { get, post, put } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerTiAgent(program: Command): void {
  const ti = program.command('ti').description('manage Ti server agent configuration, runs, and sandbox')

  const config = ti.command('config').description('manage Ti provider/model configs')

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
      const data = await get(`/api/v1/ti/configs${qs}`)
      if (opts.json) return printJson(data)
      printTable(data as Record<string, unknown>[], [
        'id',
        'provider',
        'model',
        'enabled',
        'credentialStatus',
        'isDefaultAgent',
        'isDefaultChat',
      ])
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
    .option('--default-agent', 'set as default agent model for owner')
    .option('--default-chat', 'set as default chat model for owner')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/ti/configs', {
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        provider: opts.provider,
        model: opts.model,
        label: opts.label,
        apiKeyRef: opts.apiKeyRef,
        credentialStatus: opts.credentialStatus,
        enabled: !opts.disabled,
        isDefaultAgent: Boolean(opts.defaultAgent),
        isDefaultChat: Boolean(opts.defaultChat),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  config
    .command('default <configId>')
    .description('set a Ti model config as the owner default')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--target <target>', 'chat|agent|both', 'both')
    .option('--json', 'output raw JSON')
    .action(async (configId, opts) => {
      const data = await post('/api/v1/ti/configs/default', {
        configId,
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        target: opts.target,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  ti
    .command('resolve-model')
    .description('resolve requested Ti provider/model with default fallback')
    .option('--owner-id <id>', 'owner actor id')
    .option('--owner-type <type>', 'human|agent')
    .option('--provider <provider>', 'requested Ti provider')
    .option('--model <model>', 'requested Ti model')
    .option('--target <target>', 'chat|agent', 'agent')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/ti/resolve-model', {
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        requestedProvider: opts.provider,
        requestedModel: opts.model,
        target: opts.target,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const policy = ti.command('policy').description('manage Ti agent execution policy')

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
      const data = await get(`/api/v1/ti/policy${qs}`)
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
      const data = await put('/api/v1/ti/policy', {
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

  const runs = ti.command('run').description('manage and trigger Ti agent runs')

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
      const data = await get(`/api/v1/ti/runs${qs}`)
      if (opts.json) return printJson(data)
      const rows = (data as Record<string, unknown>[]).map((run) => ({
        id: run.id,
        status: run.status,
        taskId: run.taskId,
        scheduleRunId: run.scheduleRunId,
        actualProvider: run.actualProvider,
        actualModel: run.actualModel,
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
    .option('--workspace-policy <policy>', 'ephemeral|persistent_purged_on_finish', 'ephemeral')
    .option('--max-retries <n>', 'maximum retries')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const body: Record<string, unknown> = {
        taskId: opts.task,
        scheduleRunId: opts.scheduleRun,
        assignedAgentId: opts.assignedAgent,
        assignedAgentType: 'agent',
        requestedProvider: opts.provider,
        requestedModel: opts.model,
        workspacePolicy: opts.workspacePolicy,
      }
      if (opts.maxRetries !== undefined) body.maxRetries = Number(opts.maxRetries)
      const data = await post('/api/v1/ti/runs', body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  runs
    .command('get <id>')
    .description('get a Ti agent run with target details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/ti/runs/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  ti
    .command('logs <id>')
    .description('view or follow execution logs of a Ti agent run')
    .option('-f, --follow', 'follow log output in real-time until run completes')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (opts.json && !opts.follow) {
        const data = await get(`/api/v1/ti/runs/${id}`)
        return printJson(data)
      }

      let printedEvents = 0
      let terminal = false

      while (!terminal) {
        const run: any = await get(`/api/v1/ti/runs/${id}`)
        const eventLog: unknown[] = Array.isArray(run.eventLog) ? run.eventLog : []

        while (printedEvents < eventLog.length) {
          const item = eventLog[printedEvents]
          if (typeof item === 'string') {
            console.log(item)
          } else if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>
            if (obj.chunk) {
              process.stdout.write(String(obj.chunk))
            } else if (obj.message) {
              console.log(String(obj.message))
            } else {
              console.log(JSON.stringify(obj))
            }
          }
          printedEvents++
        }

        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
          terminal = true
          if (run.outputSummary) {
            console.log('\n--- Output Summary ---')
            console.log(run.outputSummary)
          }
          if (run.errorMessage) {
            console.error('\n--- Error ---')
            console.error(run.errorMessage)
          }
          console.log(`\nRun ${id} finished with status: ${run.status}`)
          if (run.status === 'failed') process.exitCode = 1
          break
        }

        if (!opts.follow) {
          console.log(`\nRun ${id} is currently: ${run.status}`)
          break
        }

        await delay(1000)
      }
    })

  const sandbox = ti.command('sandbox').description('interact with Partners sandbox environments')

  sandbox
    .command('shell <sessionId>')
    .description('open an interactive PTY shell in a Partners sandbox session')
    .option('--command <cmd>', 'command to run in container', '/bin/sh')
    .option('--gateway-url <url>', 'Partners Gateway URL (defaults to PARTNERS_GATEWAY_URL env)')
    .option('--token <token>', 'Partners Gateway Service Token (defaults to PARTNERS_GATEWAY_SERVICE_TOKEN env)')
    .action(async (sessionId, opts) => {
      const gatewayUrl = opts.gatewayUrl ?? process.env.PARTNERS_GATEWAY_URL ?? 'http://127.0.0.1:3000'
      const serviceToken = opts.token ?? process.env.PARTNERS_GATEWAY_SERVICE_TOKEN

      const cols = process.stdout.columns || 80
      const rows = process.stdout.rows || 24

      // Request PTY initialization from Partners Gateway
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (serviceToken) {
        headers['Authorization'] = `Bearer ${serviceToken}`
      }

      console.log(`Requesting PTY for session ${sessionId}...`)
      const res = await fetch(`${gatewayUrl}/v1/sessions/${encodeURIComponent(sessionId)}/pty`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cols,
          rows,
          command: opts.command,
        }),
      })

      if (!res.ok) {
        const errorText = await res.text()
        console.error(`Failed to initialize PTY: ${res.status} ${errorText}`)
        process.exit(1)
      }

      const ptyData = (await res.json()) as { wsUrl?: string; ptyEndpoint?: string }
      let targetWsUrl = ptyData.wsUrl
      if (!targetWsUrl && ptyData.ptyEndpoint) {
        const parsedBase = new URL(gatewayUrl)
        const wsProto = parsedBase.protocol === 'https:' ? 'wss:' : 'ws:'
        targetWsUrl = `${wsProto}//${parsedBase.host}${ptyData.ptyEndpoint}`
      }

      if (!targetWsUrl) {
        console.error('Partners Gateway did not provide a WebSocket URL')
        process.exit(1)
      }

      // Append command and dimensions query params
      const wsUrlObj = new URL(targetWsUrl)
      wsUrlObj.searchParams.set('cols', String(cols))
      wsUrlObj.searchParams.set('rows', String(rows))
      wsUrlObj.searchParams.set('command', opts.command)

      console.log(`Connecting to ${wsUrlObj.toString()}...`)

      const ws = new WebSocket(wsUrlObj.toString(), {
        headers: serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {},
      } as any)

      const cleanup = () => {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false)
        }
        process.stdin.pause()
      }

      ws.addEventListener('open', () => {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(true)
          process.stdin.resume()

          process.stdin.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk.toString('utf8'))
            }
          })

          process.stdout.on('resize', () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'resize',
                cols: process.stdout.columns || 80,
                rows: process.stdout.rows || 24,
              }))
            }
          })
        }
      })

      ws.addEventListener('message', (event) => {
        const text = typeof event.data === 'string' ? event.data : String(event.data)
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object') {
            if (parsed.type === 'exit') {
              cleanup()
              console.log(`\nSession exited with code ${parsed.exitCode}`)
              process.exit(parsed.exitCode ?? 0)
            }
            if (parsed.type === 'error') {
              console.error(`\nPTY Error: ${parsed.error}`)
              cleanup()
              process.exit(1)
            }
          }
        } catch {
          // Normal stdout chunk
        }
        process.stdout.write(text)
      })

      ws.addEventListener('close', () => {
        cleanup()
        console.log('\nPTY session closed.')
        process.exit(0)
      })

      ws.addEventListener('error', (err) => {
        cleanup()
        console.error('WebSocket error:', err)
        process.exit(1)
      })

      process.on('SIGINT', () => {
        cleanup()
        ws.close()
        process.exit(0)
      })
    })

  const worker = ti.command('worker').description('Partners Gateway worker status and health')

  worker
    .command('status')
    .description('show API-side Partners Gateway worker status')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get('/api/v1/ti/worker/status')
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  worker
    .command('health')
    .description('check Partners Gateway connectivity')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get('/api/v1/ti/worker/health')
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
}
