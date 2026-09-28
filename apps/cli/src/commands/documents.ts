import { Command } from 'commander'
import * as readline from 'readline/promises'
import { get, post, patch, del } from '../client.js'
import { printJson, printTable, printKv } from '../output.js'

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

function summarizeDocument(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    summary: row.summary,
    docType: row.docType,
    tags: row.tags,
    keywords: row.keywords,
    readingTimeMin: row.readingTimeMin,
    version: row.version,
    needsReview: row.needsReview,
    updatedAt: row.updatedAt,
  }
}

export function registerDocuments(program: Command): void {
  const doc = program.command('doc').description('manage knowledge base documents')

  doc
    .command('list')
    .description('list document catalog entries; use doc search for content search')
    .option('--project <id>', 'filter by project')
    .option('--project-only', 'exclude global documents when --project is set')
    .option('--include-personal', 'include the current actor personal documents')
    .option('--type <docType>', 'requirement|design|meeting|guide|reference|skill|other')
    .option('--tag <tag>', 'filter by tag')
    .option('--query <text>', 'search document title and summary')
    .option('--page <n>', 'page number', '1')
    .option('--page-size <n>', 'items per page (summary default: 20; full default: 5)')
    .option('--full', 'include Markdown content; requires --json')
    .option('--json', 'output JSON with explicit view and pagination metadata')
    .action(async (opts) => {
      if (opts.full && !opts.json) throw new Error('--full requires --json')
      const view = opts.full ? 'full' : 'summary'
      const page = Number(opts.page)
      const pageSize = Number(opts.pageSize ?? (opts.full ? 5 : 20))
      const params = new URLSearchParams({
        view,
        page: String(page),
        pageSize: String(pageSize),
        includeGlobal: String(!opts.projectOnly),
        includePersonal: String(Boolean(opts.includePersonal)),
      })
      if (opts.project) params.set('projectId', opts.project)
      if (opts.type) params.set('docType', opts.type)
      if (opts.tag) params.set('tag', opts.tag)
      if (opts.query) params.set('query', opts.query)

      const data = await get<ListResponse>(`/api/v1/documents?${params}`)
      const result = normalizeList(data, page, pageSize)
      const items = opts.full ? result.items : result.items.map(summarizeDocument)
      const meta = {
        view,
        isFull: Boolean(opts.full),
        omitted: opts.full ? [] : ['content', 'generationPrompt'],
        page: result.page,
        pageSize: result.pageSize,
        pageCount: result.pageCount,
        total: result.total,
        nextPage: result.page < result.pageCount ? result.page + 1 : null,
        filters: {
          projectId: opts.project ?? null,
          projectOnly: Boolean(opts.projectOnly),
          includePersonal: Boolean(opts.includePersonal),
          docType: opts.type ?? null,
          tag: opts.tag ?? null,
          query: opts.query ?? null,
        },
        detailCommand: 'tw doc get <id> --json',
        contentSearchCommand: 'tw doc search <query> --json',
      }
      if (opts.json) return printJson({ items, meta })
      printTable(items, ['docType', 'title', 'summary', 'updatedAt', 'id'])
      console.log('Summary view only; Markdown content and generation metadata are omitted.')
      console.log(`Page ${result.page}/${Math.max(result.pageCount, 1)} · ${result.total} documents · use --page <n> or tw doc get <id> --json`)
    })

  doc
    .command('get <id>')
    .description('get document details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/documents/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('create')
    .description('create a document')
    .requiredOption('--title <title>', 'document title')
    .requiredOption('--content <content>', 'document content (Markdown)')
    .option('--project <id>', 'project ID (omit for global document)')
    .option('--type <docType>', 'requirement|design|meeting|guide|reference|skill|other')
    .option('--summary <summary>', 'brief summary')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/documents', {
        title: opts.title,
        content: opts.content,
        projectId: opts.project,
        docType: opts.type,
        summary: opts.summary,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('update <id>')
    .description('update a document')
    .option('--title <title>', 'new title')
    .option('--content <content>', 'new content (Markdown)')
    .option('--summary <summary>', 'new summary')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.title) body.title = opts.title
      if (opts.content) body.content = opts.content
      if (opts.summary) body.summary = opts.summary
      const data = await patch(`/api/v1/documents/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('delete <id>')
    .description('hard-delete a document')
    .option('--force', 'skip confirmation prompt')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (!opts.force) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Delete document ${id}? This action cannot be undone. [y/N] `)
        rl.close()
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.')
          process.exit(0)
        }
      }
      await del(`/api/v1/documents/${id}`)
      if (opts.json) return printJson({ deleted: true, id })
      console.log(`Document ${id} deleted.`)
    })

  doc
    .command('search <query>')
    .description('search documents')
    .option('--project <id>', 'scope to a project')
    .option('--mode <mode>', 'keyword|semantic|hybrid (default: hybrid)', 'hybrid')
    .option('--json', 'output raw JSON')
    .action(async (query, opts) => {
      const params = new URLSearchParams({ query, mode: opts.mode })
      if (opts.project) params.set('projectId', opts.project)
      const data = await get<unknown[] | { items?: unknown[]; metadata?: unknown }>(`/api/v1/search/documents?${params}`)
      const items = Array.isArray(data) ? data : (data.items ?? [])
      const metadata = Array.isArray(data) ? undefined : data.metadata
      if (opts.json) return printJson(metadata === undefined ? { items } : { items, metadata })
      if (metadata && typeof metadata === 'object') {
        const details = metadata as { effectiveMode?: string; fallbackReason?: string }
        console.log(`effective mode: ${details.effectiveMode ?? 'unknown'}${details.fallbackReason ? ` (fallback: ${details.fallbackReason})` : ''}`)
      }
      printTable(items as Record<string, unknown>[], ['id', 'title', 'score'])
    })

  doc
    .command('links <id>')
    .description('list document links')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/documents/${id}`)
      const outgoing = ((data as any).outgoingLinks ?? []).map((link: any) => ({
        id: link.id,
        targetDocId: link.targetDocId,
        title: link.targetDoc?.title,
        linkType: link.linkType,
        context: link.context,
      }))
      const incoming = ((data as any).incomingLinks ?? []).map((link: any) => ({
        id: link.id,
        sourceDocId: link.sourceDocId,
        title: link.sourceDoc?.title,
        linkType: link.linkType,
        context: link.context,
      }))
      const tasks = ((data as any).taskLinks ?? []).map((link: any) => ({
        id: link.id,
        taskId: link.taskId,
        title: link.task?.title,
        status: link.task?.status,
        linkType: link.linkType,
      }))
      const requirements = ((data as any).requirementLinks ?? []).map((link: any) => ({
        id: link.id,
        requirementId: link.requirementId,
        title: link.requirement?.title,
        status: link.requirement?.status,
        linkType: link.linkType,
      }))
      if (opts.json) return printJson({ outgoing, incoming, tasks, requirements })

      console.log('Outgoing document links:')
      printTable(outgoing as Record<string, unknown>[], ['id', 'targetDocId', 'title', 'linkType', 'context'])
      console.log('Incoming document links:')
      printTable(incoming as Record<string, unknown>[], ['id', 'sourceDocId', 'title', 'linkType', 'context'])
      console.log('Linked tasks:')
      printTable(tasks as Record<string, unknown>[], ['id', 'taskId', 'title', 'status', 'linkType'])
      console.log('Linked requirements:')
      printTable(requirements as Record<string, unknown>[], ['id', 'requirementId', 'title', 'status', 'linkType'])
    })

  doc
    .command('backlinks <id>')
    .description('list documents that link to this document')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/documents/${id}/backlinks`)
      if (opts.json) return printJson(data)
      const items = Array.isArray(data) ? data : []
      const rows = items.map((link: any) => ({
        id: link.id,
        sourceDocId: link.sourceDocId,
        title: link.sourceDoc?.title,
        linkType: link.linkType,
        context: link.context,
      }))
      printTable(rows as Record<string, unknown>[], ['id', 'sourceDocId', 'title', 'linkType', 'context'])
    })

  doc
    .command('link <id> <targetDocId>')
    .description('link this document to another document')
    .option('--type <type>', 'reference|related|parent (default: reference)', 'reference')
    .option('--context <context>', 'link context')
    .option('--json', 'output raw JSON')
    .action(async (id, targetDocId, opts) => {
      const data = await post(`/api/v1/documents/${id}/links`, {
        targetDocId,
        linkType: opts.type,
        context: opts.context,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('unlink <id> <linkId>')
    .description('remove a document-to-document link')
    .option('--json', 'output raw JSON')
    .action(async (id, linkId, opts) => {
      const data = await del(`/api/v1/documents/${id}/links/${linkId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('link-task <id> <taskId>')
    .description('link this document to a task')
    .option('--type <type>', 'references|documents|output (default: references)', 'references')
    .option('--json', 'output raw JSON')
    .action(async (id, taskId, opts) => {
      const data = await post(`/api/v1/documents/${id}/task-links`, {
        taskId,
        linkType: opts.type,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('unlink-task <id> <linkId>')
    .description('remove a document-to-task link')
    .option('--json', 'output raw JSON')
    .action(async (id, linkId, opts) => {
      const data = await del(`/api/v1/documents/${id}/task-links/${linkId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('link-req <id> <requirementId>')
    .description('link this document to a requirement')
    .option('--type <type>', 'references|documents|output (default: references)', 'references')
    .option('--json', 'output raw JSON')
    .action(async (id, requirementId, opts) => {
      const data = await post(`/api/v1/requirements/${requirementId}/document-links`, {
        documentId: id,
        linkType: opts.type,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('unlink-req <requirementId> <linkId>')
    .description('remove a document-to-requirement link')
    .option('--json', 'output raw JSON')
    .action(async (requirementId, linkId, opts) => {
      const data = await del(`/api/v1/requirements/${requirementId}/document-links/${linkId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('versions <id>')
    .description('list document versions')
    .option('--limit <n>', 'max versions to return (default: 50)', '50')
    .option('--offset <n>', 'versions to skip (default: 0)', '0')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams({ limit: opts.limit, offset: opts.offset })
      const data = await get(`/api/v1/documents/${id}/versions?${params}`)
      if (opts.json) return printJson(data)
      const items = Array.isArray(data) ? data : (data as any).items || []
      printTable(items as Record<string, unknown>[], ['version', 'title', 'changeType', 'changedBy', 'createdAt'])
    })

  doc
    .command('version <id> <version>')
    .description('get a specific document version')
    .option('--json', 'output raw JSON')
    .action(async (id, version, opts) => {
      const data = await get(`/api/v1/documents/${id}/versions/${version}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('compare <id>')
    .description('compare two document versions')
    .requiredOption('--from <version>', 'source version')
    .requiredOption('--to <version>', 'target version')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams({ from: opts.from, to: opts.to })
      const data = await get(`/api/v1/documents/${id}/versions/compare?${params}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  doc
    .command('revert <id> <version>')
    .description('revert a document to a previous version')
    .option('--change-description <text>', 'change description')
    .option('--json', 'output raw JSON')
    .action(async (id, version, opts) => {
      const data = await post(`/api/v1/documents/${id}/revert`, {
        version: Number(version),
        changeDescription: opts.changeDescription,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
}
