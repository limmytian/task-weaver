import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { installPluginSchema, upgradePluginSchema, recoverPluginSchema, changePluginStatusSchema, invokePluginSchema, pluginManifestSchema } from '@task-weaver/contracts'
import { pluginPermissionDiff } from '@task-weaver/core'
import { get, post } from '../client.js'
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
        const data = await post(`/api/v1/plugins/${encodeURIComponent(id)}/${name}`, schema.parse(await readJson(opts.file)))
        if (opts.json) return printJson(data)
        printKv(data as Record<string, unknown>)
      })
  }
}
