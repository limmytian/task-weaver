import { Command } from 'commander'
import { get, post, patch, del } from '../client.js'
import { printJson, printTable, printKv } from '../output.js'

export function registerMemory(program: Command): void {
  const mem = program.command('memory').description('record and retrieve memories')

  mem
    .command('record')
    .description('record a new memory')
    .requiredOption('--title <title>', 'short title for the memory')
    .requiredOption('--content <content>', 'full memory content (Markdown)')
    .option('--type <type>', 'user|feedback|project|reference|other', 'other')
    .option('--project <id>', 'scope to a project')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--entity-type <type>', 'project|requirement|task|document')
    .option('--entity-id <id>', 'entity UUID to link this memory to')
    .option('--expires <datetime>', 'expiry datetime (ISO 8601)')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/memories', {
        title: opts.title,
        content: opts.content,
        memoryType: opts.type,
        projectId: opts.project,
        tags: opts.tags ? opts.tags.split(',') : undefined,
        entityType: opts.entityType,
        entityId: opts.entityId,
        expiresAt: opts.expires,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mem
    .command('search <query>')
    .description('search memories by keyword or intent')
    .option('--type <type>', 'filter by memory type')
    .option('--project <id>', 'scope to a project')
    .option('--project-only', 'exclude global memories when --project is set')
    .option('--actor <id>', 'filter by actor who recorded')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--entity-type <type>', 'filter by entity type')
    .option('--entity-id <id>', 'filter by entity ID')
    .option('--limit <n>', 'max results (default: 10)', '10')
    .option('--json', 'output raw JSON')
    .action(async (query, opts) => {
      const params = new URLSearchParams({ query })
      if (opts.type) params.set('memoryType', opts.type)
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      if (opts.actor) params.set('createdBy', opts.actor)
      if (opts.tags) params.set('tags', opts.tags)
      if (opts.entityType) params.set('entityType', opts.entityType)
      if (opts.entityId) params.set('entityId', opts.entityId)
      if (opts.limit) params.set('limit', opts.limit)
      const data = await get<{ items: unknown[] }>(`/api/v1/memories/search?${params}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'memoryType', 'createdBy', 'createdAt'])
    })

  mem
    .command('list')
    .description('list memories with optional filters')
    .option('--type <type>', 'filter by memory type')
    .option('--project <id>', 'scope to a project')
    .option('--project-only', 'exclude global memories when --project is set')
    .option('--actor <id>', 'filter by actor who recorded')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--entity-type <type>', 'filter by entity type')
    .option('--entity-id <id>', 'filter by entity ID')
    .option('--limit <n>', 'max results', '20')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.type) params.set('memoryType', opts.type)
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      if (opts.actor) params.set('createdBy', opts.actor)
      if (opts.tags) params.set('tags', opts.tags)
      if (opts.entityType) params.set('entityType', opts.entityType)
      if (opts.entityId) params.set('entityId', opts.entityId)
      if (opts.limit) params.set('limit', opts.limit)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{ items: unknown[] }>(`/api/v1/memories${qs}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'memoryType', 'createdBy', 'createdAt'])
    })

  mem
    .command('get <id>')
    .description('get full memory content')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/memories/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mem
    .command('update <id>')
    .description('update a memory')
    .option('--title <title>', 'new title')
    .option('--content <content>', 'new content')
    .option('--type <type>', 'new memory type')
    .option('--tags <tags>', 'new comma-separated tags')
    .option('--expires <datetime>', 'new expiry (ISO 8601), pass "none" to clear')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.title) body.title = opts.title
      if (opts.content) body.content = opts.content
      if (opts.type) body.memoryType = opts.type
      if (opts.tags) body.tags = opts.tags.split(',')
      if (opts.expires === 'none') body.expiresAt = null
      else if (opts.expires) body.expiresAt = opts.expires
      const data = await patch(`/api/v1/memories/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  mem
    .command('forget <id>')
    .description('delete a memory')
    .action(async (id) => {
      await del(`/api/v1/memories/${id}`)
      console.log(`Memory ${id} deleted`)
    })

  mem
    .command('entity <entityType> <entityId>')
    .description('list memories attached to a specific entity')
    .option('--json', 'output raw JSON')
    .action(async (entityType, entityId, opts) => {
      const data = await get<{ items: unknown[] }>(`/api/v1/memories/entity/${entityType}/${entityId}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'memoryType', 'createdBy'])
    })
}
