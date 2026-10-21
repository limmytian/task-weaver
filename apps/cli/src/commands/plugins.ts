import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { installPluginSchema, upgradePluginSchema, recoverPluginSchema, changePluginStatusSchema, invokePluginSchema, pluginManifestSchema, pluginSkillBindingSchema, pluginToolBindingSchema } from '@task-weaver/contracts'
import { pluginPermissionDiff, capabilityDigest } from '@task-weaver/core'
import { ApiError, get, post } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'

async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path)
  if (bytes.length > 131072) throw new Error('Plugin request exceeds the 131072-byte limit')
  return JSON.parse(bytes.toString('utf8'))
}

export function registerPlugins(program: Command): void {
  const plugin = program.command('plugin').description('manage isolated backend plugins and installation-owned state')
  plugin.command('list')
    .option('--scope <scope>', 'personal|global (use --project for project scope)', 'personal')
    .option('--project <id>', 'list plugins in one project')
    .option('--limit <n>', 'maximum results (1-20)', '20')
    .option('--offset <n>', 'pagination offset', '0')
    .option('--json', 'output raw JSON')
    .action(async opts => {
      const query = new URLSearchParams({ scope: opts.project ? 'project' : opts.scope, limit: opts.limit, offset: opts.offset })
      if (opts.project) query.set('projectId', opts.project)
      const data = await get<{ items: Record<string, unknown>[] }>(`/api/v1/plugins?${query}`)
      if (opts.json) return printJson(data)
      printTable(data.items, ['id', 'pluginId', 'revision', 'status'])
    })
  plugin.command('get <id>').option('--json', 'output raw JSON').option('--manifest', 'output only the current manifest').action(async (id, opts) => {
    const data = await get<Record<string, unknown>>(`/api/v1/plugins/${encodeURIComponent(id)}`)
    if (opts.manifest) return printJson(data.manifest)
    if (opts.json) return printJson(data)
    printKv(data as Record<string, unknown>)
  })
  plugin.command('view <id>').description('print the authenticated application viewer URL').option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<{ viewerUrl?: string | null }>(`/api/v1/plugins/${encodeURIComponent(id)}`)
      if (!data.viewerUrl) throw new Error('This installation has no available application viewer')
      if (opts.json) return printJson({ url: data.viewerUrl })
      console.log(data.viewerUrl)
    })
  plugin.command('generations <id>').description('list immutable generation hashes for reviewed recovery')
    .option('--limit <n>', 'maximum results (1-20)', '20').option('--offset <n>', 'pagination offset', '0').option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const query = new URLSearchParams({ limit: opts.limit, offset: opts.offset })
      const data = await get<{ items: Record<string, unknown>[] }>(`/api/v1/plugins/${encodeURIComponent(id)}/generations?${query}`)
      if (opts.json) return printJson(data)
      printTable(data.items, ['version', 'manifestHash', 'verifiedAtInstall', 'createdAt'])
    })
  plugin.command('generation <id> <version>').description('inspect a pinned manifest before recovery')
    .option('--manifest', 'output only the manifest').option('--json', 'output raw JSON')
    .action(async (id, version, opts) => {
      const data = await get<Record<string, unknown>>(`/api/v1/plugins/${encodeURIComponent(id)}/generations/${encodeURIComponent(version)}`)
      if (opts.manifest) return printJson(data.manifest)
      if (opts.json) return printJson(data)
      printKv(data)
    })
  plugin.command('skill-binding <id>').description('read hosted skill instructions and print an exact binding for manifest review')
    .requiredOption('--name <name>', 'unique binding name inside the plugin')
    .option('--json', 'output the binding as JSON')
    .action(async (id, opts) => {
      const response = await post<{ structuredContent?: { ok: boolean; data?: { id: string; version: number; content: string } } }>('/api/v1/mcp-server/tools/tw_context_get', { id })
      const skill = response.structuredContent?.ok ? response.structuredContent.data : undefined
      if (!skill) throw new Error('The hosted skill is unavailable or cannot be read')
      printJson(pluginSkillBindingSchema.parse({ name: opts.name, documentId: skill.id, version: skill.version, contentHash: capabilityDigest({ content: skill.content }) }))
    })
  plugin.command('tool-binding <id>').description('print a pinned read-only MCP binding for manifest review')
    .requiredOption('--name <name>', 'unique tool binding name')
    .requiredOption('--method <method>', 'declared plugin method that uses this read')
    .option('--arguments <file>', 'reviewed fixed JSON argument object')
    .option('--input-arguments <names...>', 'explicit input keys to forward as tool arguments')
    .option('--json', 'output the binding as JSON')
    .action(async (id, opts) => {
      const response = await post<{ structuredContent?: { ok: boolean; data?: { readOnly: boolean; schemaHash: string } } }>('/api/v1/mcp-server/tools/tw_mcp_tool', { toolId: id })
      const tool = response.structuredContent?.ok ? response.structuredContent.data : undefined
      if (!tool?.readOnly) throw new Error('The MCP tool is unavailable or is not approved as read-only')
      printJson(pluginToolBindingSchema.parse({ name: opts.name, method: opts.method, toolId: id, schemaHash: tool.schemaHash, arguments: opts.arguments ? await readJson(opts.arguments) : {}, ...(opts.inputArguments ? { inputArguments: opts.inputArguments } : {}) }))
    })
  plugin.command('diff').description('review the exact permissions added or removed between manifests')
    .requiredOption('--current <file>', 'current manifest JSON')
    .requiredOption('--next <file>', 'candidate manifest JSON')
    .action(async opts => printJson(pluginPermissionDiff(pluginManifestSchema.parse(await readJson(opts.current)), pluginManifestSchema.parse(await readJson(opts.next)))))
  plugin.command('install').description('install a reviewed manifest using an explicit confirmation and retry key')
    .requiredOption('--file <file>', 'complete install request JSON')
    .option('--json', 'output raw JSON')
    .action(async opts => {
      const data = await post('/api/v1/plugins', installPluginSchema.parse(await readJson(opts.file)))
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
  for (const [name, schema] of Object.entries({ upgrade: upgradePluginSchema, recover: recoverPluginSchema, status: changePluginStatusSchema, invoke: invokePluginSchema })) {
    plugin.command(`${name} <id>`).description(`${name} using a reviewed request with explicit revision, confirmation and retry key`)
      .requiredOption('--file <file>', 'complete request JSON; retry the identical file after an ambiguous response')
      .option('--json', 'output raw JSON')
      .action(async (id, opts) => {
        const data = await post(`/api/v1/plugins/${encodeURIComponent(id)}/${name}`, schema.parse(await readJson(opts.file))).catch(error => {
          if (error instanceof ApiError && error.status === 403 && error.body && typeof error.body === 'object' && 'approvalId' in error.body) {
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
  }
}
