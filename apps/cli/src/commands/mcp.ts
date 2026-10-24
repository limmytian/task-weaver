import { Command } from 'commander'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInterface } from 'readline/promises'
import { ApiError, get, post, patch } from '../client.js'
import { printJson, printTable, printKv } from '../output.js'
import { loadConfig } from '../config.js'
import { serveMcp } from '../mcp-server.js'

async function confirmLocalScopeShare(serverId: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write('Error: --shared exposes this local MCP server to other clients using this registration credential. Re-run with --yes to confirm.\n')
    process.exit(1)
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  try {
    const answer = await rl.question(
      `Share MCP server ${serverId} with other clients using this registration credential? Type "yes" to continue: `,
    )
    if (answer.trim().toLowerCase() !== 'yes') {
      process.stderr.write('Aborted.\n')
      process.exit(1)
    }
  } finally {
    rl.close()
  }
}

export function registerMcp(program: Command): void {
  const mcp = program.command('mcp').description('serve Task Weaver or discover external MCP registry tools')
  mcp.command('readiness <serverId>').description('inspect scoped connection and hosted runtime readiness').option('--json', 'output JSON').action(async serverId => printJson(await get(`/api/v1/mcp/servers/${serverId}/readiness`)))
  mcp.command('audit').option('--limit <n>', 'page size', '20').option('--offset <n>', 'page offset', '0').option('--project <id>', 'project scope').option('--personal', 'personal scope').option('--json', 'output JSON')
    .action(async opts => {
      const query = new URLSearchParams({ limit: opts.limit, offset: opts.offset })
      if (opts.project) query.set('projectId', opts.project)
      if (opts.personal) query.set('personal', 'true')
      printJson(await get(`/api/v1/mcp/audit?${query}`))
    })
  mcp.command('policy <toolId> <mode>').description('set allow, approval or deny for a tool or *')
    .option('--project <id>', 'project scope').option('--personal', 'personal scope').option('--json', 'output JSON')
    .action(async (toolId, mode, opts) => printJson(await post('/api/v1/mcp/policy', { toolId, mode, projectId: opts.project, personal: opts.personal ?? false })))
  mcp.command('approval <id>').description('inspect approval binding metadata').option('--json', 'output JSON')
    .action(async id => printJson(await get(`/api/v1/mcp/approvals/${id}`)))
  mcp.command('audit-cleanup').option('--project <id>', 'project scope').option('--personal', 'personal scope').option('--json', 'output JSON')
    .action(async opts => printJson(await post('/api/v1/mcp/audit/cleanup', { projectId: opts.project, personal: opts.personal ?? false })))
  mcp.command('approve <id>').description('approve an exact invocation request').option('--json', 'output JSON')
    .action(async id => printJson(await post(`/api/v1/mcp/approvals/${id}/approve`, {})))
  mcp.command('tool-authorization <id>').description('configure trusted tool scope and read-only declarations')
    .option('--read-only', 'declare a read-only tool').option('--target-project-argument <name>', 'top-level project ID argument').option('--json', 'output JSON')
    .action(async (id, opts) => printJson(await patch(`/api/v1/mcp/tools/${id}/authorization`, { readOnly: opts.readOnly ?? false, targetProjectArgument: opts.targetProjectArgument ?? null })))


  mcp.command('serve').description('serve Task Weaver tools over authenticated stdio')
    .option('--read-only', 'hide write tools and reject write calls')
    .action(serveMcp)

  mcp
    .command('search <intent>')
    .description('search for tools by describing what you need')
    .option('--server <id>', 'filter by server')
    .option('--tags <tags>', 'comma-separated tag filter')
    .option('--project <id>', 'include project-scoped MCP tools')
    .option('--project-only', 'exclude global MCP tools when --project is set')
    .option('--limit <n>', 'max results (default: 10)', '10')
    .option('--json', 'output raw JSON')
    .action(async (intent, opts) => {
      const config = loadConfig()
      const params = new URLSearchParams({ intent })
      if (opts.server) params.set('serverId', opts.server)
      if (opts.tags) params.set('tags', opts.tags)
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      if (opts.limit) params.set('limit', opts.limit)
      if (config.clientId) params.set('clientId', config.clientId)
      if (config.nodeId) params.set('nodeId', config.nodeId)
      const data = await get<{ items: unknown[] }>(`/api/v1/mcp/tools/search?${params}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'name', 'description', 'serverName'])
    })

  mcp
    .command('call <toolId>')
    .description('execute a tool via proxy')
    .option('--schema-hash <sha256>', 'exact schema hash observed when inspecting the tool')
    .option('--params <json>', 'tool arguments as JSON', '{}')
    .option('--approval <id>', 'approved exact-operation request ID')
    .option('--json', 'output raw JSON')
    .action(async (toolId, opts) => {
      let args: Record<string, unknown> | undefined
      try {
        args = JSON.parse(opts.params)
      } catch {
        process.stderr.write('Error: --params must be valid JSON\n')
        process.exit(1)
      }
      const data = await post(`/api/v1/mcp/tools/${toolId}/call`, { arguments: args, approvalId: opts.approval, expectedSchemaHash: opts.schemaHash }).catch(error => {
        if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === 'object' && 'approvalId' in error.body) {
          printJson(error.body)
          process.exitCode = 1
          return undefined
        }
        throw error
      })
      if (data === undefined) return
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mcp
    .command('tool <id>')
    .description('get tool detail and input schema')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/mcp/tools/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mcp
    .command('tools')
    .description('list all indexed tools')
    .option('--server <id>', 'filter by server')
    .option('--project <id>', 'include project-scoped MCP tools')
    .option('--project-only', 'exclude global MCP tools when --project is set')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const config = loadConfig()
      const params = new URLSearchParams({ intent: '*' })
      if (opts.server) params.set('serverId', opts.server)
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      if (config.clientId) params.set('clientId', config.clientId)
      if (config.nodeId) params.set('nodeId', config.nodeId)
      params.set('limit', '20')
      const data = await get<{ items: unknown[] }>(`/api/v1/mcp/tools/search?${params}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'name', 'description', 'serverName'])
    })

  mcp
    .command('servers')
    .description('list registered MCP servers')
    .option('--project <id>', 'include project-scoped MCP servers')
    .option('--project-only', 'exclude global MCP servers when --project is set')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{ items: unknown[] }>(`/api/v1/mcp/servers${qs}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'name', 'projectId', 'transport', 'status', 'active'])
    })

  mcp
    .command('server <id>')
    .description('get server detail')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/mcp/servers/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mcp
    .command('sync <serverId>')
    .description('re-sync tools from a server')
    .option('--json', 'output raw JSON')
    .action(async (serverId, opts) => {
      const data = await post<{ items: unknown[]; count: number }>(`/api/v1/mcp/servers/${serverId}/sync`, {})
      if (opts.json) return printJson(data)
      console.log(`Synced ${data.count} tools`)
      printTable(data.items as Record<string, unknown>[], ['id', 'name', 'description'])
    })

  mcp
    .command('register-local')
    .description('register and host a local stdio MCP server, keeping it active via heartbeats')
    .requiredOption('--server <id>', 'ID of the registered MCP server')
    .requiredOption('--command <cmd>', 'command to execute')
    .option('--args <args>', 'JSON array of arguments', '[]')
    .option('--env <env>', 'JSON object of env variables', '{}')
    .option('--project <id>', 'scope this local MCP server to a project')
    .option('--shared', 'share within the authenticated registration credential (scope=local)')
    .option('--yes', 'confirm local scope sharing without an interactive prompt')
    .action(async (opts) => {
      const serverId = opts.server
      const command = opts.command
      if (opts.shared && !opts.yes) {
        await confirmLocalScopeShare(serverId)
      }

      let parsedArgs: string[] = []
      try {
        parsedArgs = JSON.parse(opts.args)
        if (!Array.isArray(parsedArgs)) {
          throw new Error('args must be a JSON array')
        }
      } catch {
        process.stderr.write('Error: --args must be a valid JSON array\n')
        process.exit(1)
      }

      let parsedEnv: Record<string, string> = {}
      try {
        parsedEnv = JSON.parse(opts.env)
        if (typeof parsedEnv !== 'object' || parsedEnv === null) {
          throw new Error('env must be a JSON object')
        }
      } catch {
        process.stderr.write('Error: --env must be a valid JSON object\n')
        process.exit(1)
      }

      const config = loadConfig()
      const clientId = config.clientId
      if (!clientId) {
        process.stderr.write('Error: No clientId found in CLI config\n')
        process.exit(1)
      }

      console.log(`Connecting to local stdio MCP server`)

      const client = new Client({ name: 'task-weaver-cli-host', version: '1.0.0' })
      const transport = new StdioClientTransport({
        command,
        args: parsedArgs,
        env: parsedEnv,
      })

      try {
        await client.connect(transport)
      } catch (err) {
        process.stderr.write(`Failed to connect to local stdio MCP server: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      }

      console.log('Successfully connected to local MCP server. Querying tool schemas...')

      let tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = []
      try {
        const response = await client.listTools()
        tools = response.tools || []
      } catch (err) {
        process.stderr.write(`Failed to list tools from MCP server: ${err instanceof Error ? err.message : String(err)}\n`)
        await client.close()
        process.exit(1)
      }

      console.log(`Found ${tools.length} tools. Registering with TaskWeaver server...`)

      const scope = opts.shared ? 'local' : 'private'

      try {
        await patch(`/api/v1/mcp/servers/${serverId}`, {
          transport: 'stdio',
          config: {
            command,
            args: parsedArgs,
          },
          clientId,
          nodeId: config.nodeId,
          projectId: opts.project,
          scope,
          localScopeConsent: scope === 'local',
        })

        await post(`/api/v1/mcp/servers/${serverId}/upload-tools`, { tools })
        console.log(`Successfully registered server and uploaded ${tools.length} tool definitions!`)
      } catch (err) {
        process.stderr.write(`Registration failed: ${err instanceof Error ? err.message : String(err)}\n`)
        await client.close()
        process.exit(1)
      }

      console.log('Starting heartbeat loop. Press Ctrl+C to terminate.')

      const sendHeartbeat = async () => {
        try {
          await post(`/api/v1/mcp/servers/${serverId}/heartbeat`, { clientId })
          console.log(`[${new Date().toLocaleTimeString()}] Heartbeat sent successfully.`)
        } catch {
          console.error("MCP heartbeat failed")
        }
      }

      await sendHeartbeat()
      const interval = setInterval(sendHeartbeat, 20000)
      let stopping = false
      const processRequests = async () => {
        while (!stopping) {
          try {
            const { items } = await post<{ items: Array<{ id: string; toolName: string; arguments: Record<string, unknown>; leaseToken: string; expiresAt: string }> }>(`/api/v1/mcp/servers/${serverId}/poll`, {})
            for (const item of items) {
              if (Date.parse(item.expiresAt) <= Date.now()) continue
              let result: Record<string, unknown>
              try {
                result = await client.callTool({ name: item.toolName, arguments: item.arguments }, undefined, { timeout: Math.max(1, Date.parse(item.expiresAt) - Date.now()) }) as Record<string, unknown>
              } catch {
                result = { isError: true, content: [{ type: 'text', text: 'Local MCP tool call failed' }] }
              }
              await post(`/api/v1/mcp/requests/${item.id}/result`, { leaseToken: item.leaseToken, result })
            }
          } catch {
            // Do not print request arguments, tool outputs, credentials or provider errors.
            process.stderr.write('Local MCP request polling failed; check registration and credentials.\n')
          }
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      void processRequests()

      const cleanup = async () => {
        stopping = true
        console.log('\nStopping heartbeat loop and shutting down...')
        clearInterval(interval)
        try {
          await client.close()
        } catch {
          // ignore
        }
        process.exit(0)
      }

      process.on('SIGINT', cleanup)
      process.on('SIGTERM', cleanup)
    })
}
