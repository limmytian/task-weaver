import { Command } from 'commander'
import { get } from '../client.js'
import { printJson, printTable } from '../output.js'

type SearchCollection = unknown[] | { items?: unknown[] }

const collect = (value: SearchCollection | undefined) =>
  Array.isArray(value) ? value : (value?.items ?? [])

const withType = (type: string, rows: unknown[]) =>
  rows.map((item) => ({
    ...(item && typeof item === 'object' ? (item as Record<string, unknown>) : { value: item }),
    type,
  }))

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('search across tasks, requirements, documents, and repositories')
    .option('--project <id>', 'scope to a project')
    .option('--entity <type>', 'task|requirement|document|repository|all (default: all)', 'all')
    .option('--mode <mode>', 'document mode: keyword|fulltext|semantic|hybrid')
    .option('--json', 'output raw JSON')
    .action(async (query, opts) => {
      const entity = String(opts.entity ?? 'all')
      const params = new URLSearchParams({ q: query })
      if (opts.project) params.set('projectId', opts.project)

      let items: Record<string, unknown>[]
      let documentMetadata: unknown
      if (entity === 'task') {
        const data = await get<SearchCollection>(`/api/v1/search/tasks?${params}`)
        items = withType('task', collect(data))
      } else if (entity === 'requirement') {
        const data = await get<SearchCollection>(`/api/v1/search/requirements?${params}`)
        items = withType('requirement', collect(data))
      } else if (entity === 'document') {
        const documentParams = new URLSearchParams({ query })
        if (opts.project) documentParams.set('projectId', opts.project)
        if (opts.mode) documentParams.set('mode', opts.mode)
        const data = await get<SearchCollection & { metadata?: unknown }>(`/api/v1/search/documents?${documentParams}`)
        documentMetadata = !Array.isArray(data) ? data.metadata : undefined
        items = withType('document', collect(data))
      } else if (entity === 'repository') {
        const data = await get<SearchCollection>(`/api/v1/search/repositories?${params}`)
        items = withType('repository', collect(data))
      } else if (entity === 'all') {
        const data = await get<{
          items?: unknown[]
          tasks?: SearchCollection
          requirements?: SearchCollection
          documents?: SearchCollection
          repositories?: SearchCollection
        }>(`/api/v1/search/all?${params}`)
        items = (data.items as Record<string, unknown>[] | undefined) ?? [
          ...withType('task', collect(data.tasks)),
          ...withType('requirement', collect(data.requirements)),
          ...withType('document', collect(data.documents)),
          ...withType('repository', collect(data.repositories)),
        ]
      } else {
        throw new Error(`Unsupported entity: ${entity}`)
      }

      const output = documentMetadata === undefined ? { items } : { items, metadata: documentMetadata }
      if (opts.json) return printJson(output)
      printTable(items, ['type', 'id', 'title', 'status'])
    })
}
