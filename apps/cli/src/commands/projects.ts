import { Command } from 'commander'
import * as readline from 'readline/promises'
import { get, post, patch } from '../client.js'
import {
  type GraphData,
  type GraphEdge,
  printDotGraph,
  printJson,
  printKv,
  printMermaidGraph,
  printTable,
} from '../output.js'

type KnowledgeGraph = GraphData & {
  projectId: string
  stats?: Record<string, unknown>
}

type ListResponse = unknown[] | {
  items?: unknown[]
  total?: number
  page?: number
  pageSize?: number
  pageCount?: number
}

function normalizeList(data: ListResponse, page: number, pageSize: number) {
  const source = Array.isArray(data) ? data : data.items ?? []
  const items = source.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
  )
  const total = Array.isArray(data) ? items.length : data.total ?? items.length
  return {
    items,
    total,
    page: Array.isArray(data) ? page : data.page ?? page,
    pageSize: Array.isArray(data) ? pageSize : data.pageSize ?? pageSize,
    pageCount: Array.isArray(data)
      ? Math.ceil(total / pageSize)
      : data.pageCount ?? Math.ceil(total / pageSize),
  }
}

function summarizeProject(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: row.updatedAt,
  }
}

function filterDag(graph: KnowledgeGraph, opts: { kind?: string; edgeType?: string }): GraphData {
  const kind = opts.kind ?? 'all'
  const edgeType = opts.edgeType ?? 'blocks'
  if (!['task', 'requirement', 'all'].includes(kind)) {
    throw new Error(`Unsupported DAG kind: ${kind}`)
  }
  if (!['blocks', 'related', 'all'].includes(edgeType)) {
    throw new Error(`Unsupported DAG edge type: ${edgeType}`)
  }
  const allowedKinds = kind === 'all' ? new Set(['task', 'requirement']) : new Set([kind])
  const allowedEdgeTypes = edgeType === 'all' ? new Set(['blocks', 'related']) : new Set([edgeType])

  const edges = graph.edges
    .filter((edge) => {
      return edge.sourceType === edge.targetType &&
        edge.sourceType !== undefined &&
        allowedKinds.has(edge.sourceType) &&
        allowedEdgeTypes.has(edge.linkType)
    })
    .map((edge): GraphEdge => ({
      ...edge,
      source: edge.target,
      target: edge.source,
    }))

  const nodeIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges,
  }
}

function printGraph(data: GraphData, opts: { format?: string; direction?: string; name?: string }): void {
  switch (opts.format ?? 'table') {
    case 'json':
      printJson(data)
      break
    case 'mermaid':
      printMermaidGraph(data, opts.direction)
      break
    case 'dot':
      printDotGraph(data, opts.name)
      break
    case 'table':
      console.log('Nodes:')
      printTable(data.nodes as unknown as Record<string, unknown>[], ['id', 'type', 'label'])
      console.log('Edges:')
      printTable(data.edges as unknown as Record<string, unknown>[], ['source', 'target', 'sourceType', 'targetType', 'linkType'])
      break
    default:
      throw new Error(`Unsupported format: ${opts.format}`)
  }
}

export function registerProjects(program: Command): void {
  const project = program.command('project').description('manage projects')

  project
    .command('list')
    .description('list active projects for navigation')
    .option('--status <status>', 'active|archived', 'active')
    .option('--query <text>', 'search project name and description')
    .option('--page <n>', 'page number', '1')
    .option('--page-size <n>', 'items per page (summary default: 20; full default: 10)')
    .option('--full', 'include descriptions; requires --json')
    .option('--json', 'output JSON with explicit view and pagination metadata')
    .action(async (opts) => {
      if (opts.full && !opts.json) throw new Error('--full requires --json')
      const view = opts.full ? 'full' : 'summary'
      const page = Number(opts.page)
      const pageSize = Number(opts.pageSize ?? (opts.full ? 10 : 20))
      const params = new URLSearchParams({
        status: opts.status,
        view,
        page: String(page),
        pageSize: String(pageSize),
      })
      if (opts.query) params.set('query', opts.query)
      const data = await get<ListResponse>(`/api/v1/projects?${params}`)
      const result = normalizeList(data, page, pageSize)
      const items = opts.full ? result.items : result.items.map(summarizeProject)
      const meta = {
        view,
        isFull: Boolean(opts.full),
        omitted: opts.full ? [] : ['description'],
        page: result.page,
        pageSize: result.pageSize,
        pageCount: result.pageCount,
        total: result.total,
        nextPage: result.page < result.pageCount ? result.page + 1 : null,
        filters: { status: opts.status, query: opts.query ?? null },
        detailCommand: 'tw project get <id> --json',
      }
      if (opts.json) return printJson({ items, meta })
      printTable(items, ['status', 'name', 'updatedAt', 'id'])
      console.log('Summary view only; description is omitted.')
      console.log(`Page ${result.page}/${Math.max(result.pageCount, 1)} · ${result.total} projects · use --page <n> or tw project get <id> --json`)
    })

  project
    .command('get <id>')
    .description('get project details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/projects/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  project
    .command('create')
    .description('create a new project')
    .requiredOption('--name <name>', 'project name')
    .option('--description <desc>', 'project description')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/projects', {
        name: opts.name,
        description: opts.description,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  project
    .command('update <id>')
    .description('update a project')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.name) body.name = opts.name
      if (opts.description) body.description = opts.description
      const data = await patch(`/api/v1/projects/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  project
    .command('delete <id>')
    .description('archive (delete) a project')
    .option('--force', 'skip confirmation prompt')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (!opts.force) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Archive project ${id}? This action cannot be undone. [y/N] `)
        rl.close()
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.')
          process.exit(0)
        }
      }
      const data = await patch(`/api/v1/projects/${id}`, { status: 'archived' })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  project
    .command('graph <id>')
    .description('show project knowledge graph')
    .option('--format <format>', 'table|json|mermaid|dot (default: table)', 'table')
    .option('--direction <dir>', 'Mermaid direction: LR|TD|BT|RL (default: LR)', 'LR')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<KnowledgeGraph>(`/api/v1/projects/${id}/knowledge-graph`)
      printGraph(data, { format: opts.json ? 'json' : opts.format, direction: opts.direction, name: 'task_weaver_graph' })
    })

  project
    .command('dag <id>')
    .description('show task/requirement dependency DAG')
    .option('--kind <kind>', 'task|requirement|all (default: all)', 'all')
    .option('--type <type>', 'blocks|related|all (default: blocks)', 'blocks')
    .option('--format <format>', 'table|json|mermaid|dot (default: mermaid)', 'mermaid')
    .option('--direction <dir>', 'Mermaid direction: LR|TD|BT|RL (default: LR)', 'LR')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const graph = await get<KnowledgeGraph>(`/api/v1/projects/${id}/knowledge-graph`)
      const dag = filterDag(graph, { kind: opts.kind, edgeType: opts.type })
      printGraph(dag, { format: opts.json ? 'json' : opts.format, direction: opts.direction, name: 'task_weaver_dag' })
    })
}
