import { Command } from 'commander'
import { get } from '../client.js'
import { printJson, printTable } from '../output.js'

export function registerActivity(program: Command): void {
  program
    .command('activity')
    .description('view activity log')
    .option('--project <id>', 'filter by project')
    .option('--entity-type <type>', 'project|task|document|requirement')
    .option('--entity <id>', 'filter by entity ID')
    .option('--actor <id>', 'filter by actor ID')
    .option('--since <date>', 'ISO 8601 start date')
    .option('--until <date>', 'ISO 8601 end date')
    .option('--limit <n>', 'max results (default: 30)', '30')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.entityType) params.set('entityType', opts.entityType)
      if (opts.entity) params.set('entityId', opts.entity)
      if (opts.actor) params.set('actorId', opts.actor)
      if (opts.since) params.set('since', opts.since)
      if (opts.until) params.set('until', opts.until)
      if (opts.limit) params.set('limit', opts.limit)
      const data = await get<{ items: unknown[] }>(`/api/v1/activity?${params}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['createdAt', 'actorId', 'entityType', 'entityId', 'action'])
    })
}
