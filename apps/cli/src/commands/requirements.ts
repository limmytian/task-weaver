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

function summarizeRequirement(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    modelTier: row.modelTier,
    branchName: row.branchName,
    updatedAt: row.updatedAt,
  }
}



export function registerRequirements(program: Command): void {
  const req = program.command('req').description('manage requirements')

  req
    .command('list')
    .description('list filtered, paginated requirement summaries')
    .requiredOption('--project <id>', 'project ID')
    .option('--status <status>', 'draft|approved|in_progress|in_review|ready_to_merge|done|cancelled|archived')
    .option('--priority <priority>', 'low|medium|high|critical')
    .option('--query <text>', 'search requirement title and description')
    .option('--completed-within-days <days>', 'include terminal requirements completed within N days', '7')
    .option('--page <n>', 'page number', '1')
    .option('--page-size <n>', 'items per page (summary default: 20; full default: 5)')
    .option('--full', 'include tasks, dependencies, and repositories; requires --json')
    .option('--json', 'output JSON with explicit view and pagination metadata')
    .action(async (opts) => {
      if (opts.full && !opts.json) {
        throw new Error('--full requires --json')
      }
      const view = opts.full ? 'full' : 'summary'
      const page = Number(opts.page)
      const pageSize = Number(opts.pageSize ?? (opts.full ? 5 : 20))
      const params = new URLSearchParams({
        view,
        page: String(page),
        pageSize: String(pageSize),
      })
      if (opts.status) params.set('status', opts.status)
      if (opts.priority) params.set('priority', opts.priority)
      if (opts.query) params.set('q', opts.query)
      params.set('completedWithinDays', String(opts.completedWithinDays))

      const data = await get<ListResponse>(`/api/v1/projects/${opts.project}/requirements?${params}`)
      const result = normalizeList(data, page, pageSize)
      const items = opts.full ? result.items : result.items.map(summarizeRequirement)
      const meta = {
        view,
        isFull: Boolean(opts.full),
        omitted: opts.full ? [] : ['description', 'tasks', 'dependencies', 'dependents', 'repositories'],
        page: result.page,
        pageSize: result.pageSize,
        pageCount: result.pageCount,
        total: result.total,
        nextPage: result.page < result.pageCount ? result.page + 1 : null,
        filters: {
          status: opts.status ?? null,
          priority: opts.priority ?? null,
          query: opts.query ?? null,
          completedWithinDays: Number(opts.completedWithinDays),
        },
        detailCommand: 'tw req get <id> --json',
      }
      if (opts.json) return printJson({ items, meta })

      printTable(items, ['status', 'priority', 'title', 'updatedAt', 'id'])
      console.log('Summary view only; description and relationship data are omitted.')
      console.log(`Page ${result.page}/${Math.max(result.pageCount, 1)} · ${result.total} requirements · use --page <n> or tw req get <id> --json`)
    })



  req
    .command('get <id>')
    .description('get requirement details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/requirements/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('create')
    .description('create a requirement')
    .requiredOption('--project <id>', 'project ID')
    .requiredOption('--title <title>', 'requirement title')
    .option('--description <desc>', 'requirement description')
    .option('--priority <priority>', 'low|medium|high|critical (default: medium)')
    .option('--status <status>', 'draft|approved|in_progress|in_review|ready_to_merge|done (default: draft)')
    .option('--model-tier <tier>', 'fast|standard|strong (default: standard)')
    .option('--branch-name <name>', 'git branch name for this requirement')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post(`/api/v1/projects/${opts.project}/requirements`, {
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        status: opts.status,
        modelTier: opts.modelTier,
        branchName: opts.branchName,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('update <id>')
    .description('update a requirement')
    .option('--title <title>', 'new title')
    .option('--description <desc>', 'new description')
    .option('--status <status>', 'new status')
    .option('--priority <priority>', 'new priority')
    .option('--model-tier <tier>', 'fast|standard|strong')
    .option('--branch-name <name>', 'git branch name for this requirement')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.title) body.title = opts.title
      if (opts.description) body.description = opts.description
      if (opts.status) body.status = opts.status
      if (opts.priority) body.priority = opts.priority
      if (opts.modelTier) body.modelTier = opts.modelTier
      if (opts.branchName !== undefined) body.branchName = opts.branchName
      const data = await patch(`/api/v1/requirements/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('delete <id>')
    .description('delete (cancel) a requirement')
    .option('--force', 'skip confirmation prompt')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (!opts.force) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Delete requirement ${id}? This action cannot be undone. [y/N] `)
        rl.close()
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.')
          process.exit(0)
        }
      }
      const data = await del(`/api/v1/requirements/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('claim <id>')
    .description('claim a requirement lane for exclusive work')
    .option('--duration <minutes>', 'lease duration in minutes (default: 30)', '30')
    .option('--daemon-id <id>', 'daemon ID metadata for the claim')
    .option('--worker-index <index>', 'worker index metadata for the claim')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/requirements/${id}/claim`, {
        durationMinutes: Number(opts.duration),
        daemonId: opts.daemonId,
        workerIndex: opts.workerIndex,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('release <id>')
    .description('release a claimed requirement lane')
    .option('--reason <reason>', 'reason for release')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/requirements/${id}/release`, {
        reason: opts.reason,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('heartbeat <id>')
    .description('extend a requirement lane claim')
    .option('--extend <minutes>', 'minutes to extend from now (default: 30)', '30')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/requirements/${id}/heartbeat`, {
        extendMinutes: Number(opts.extend),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('claim-status <id>')
    .description('show current requirement lane claim')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/requirements/${id}/claim`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req
    .command('claims')
    .description('list active requirement lane claims')
    .option('--project <id>', 'filter by project ID')
    .option('--claimed-by <id>', 'filter by claim holder')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.claimedBy) params.set('claimedBy', opts.claimedBy)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get(`/api/v1/requirement-claims${qs}`)
      if (opts.json) return printJson(data)
      const items = Array.isArray(data) ? data : (data as any).items || []
      printTable(items as Record<string, unknown>[], ['id', 'requirementId', 'claimedBy', 'expiresAt'])
    })

  const dep = req.command('dep').description('manage requirement dependencies')

  dep
    .command('list <id>')
    .description('list blockers and dependents for a requirement')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/requirements/${id}/dependencies`)
      if (opts.json) return printJson(data)
      const dependencies = (data as any).dependencies ?? []
      const dependents = (data as any).dependents ?? []
      console.log('Dependencies:')
      printTable(dependencies as Record<string, unknown>[], ['id', 'dependsOnRequirementId', 'type', 'description'])
      console.log('Dependents:')
      printTable(dependents as Record<string, unknown>[], ['id', 'requirementId', 'type', 'description'])
    })

  dep
    .command('add <id> <dependsOnRequirementId>')
    .description('add a dependency from one requirement to another')
    .option('--type <type>', 'blocks|related (default: blocks)', 'blocks')
    .option('--description <desc>', 'dependency description')
    .option('--json', 'output raw JSON')
    .action(async (id, dependsOnRequirementId, opts) => {
      const data = await post(`/api/v1/requirements/${id}/dependencies`, {
        dependsOnRequirementId,
        type: opts.type,
        description: opts.description,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  dep
    .command('remove <id> <depId>')
    .description('remove a requirement dependency')
    .option('--json', 'output raw JSON')
    .action(async (id, depId, opts) => {
      const data = await del(`/api/v1/requirements/${id}/dependencies/${depId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const slice = req.command('slice').description('manage requirement execution slices')

  slice
    .command('list <id>')
    .description('list execution slices for a requirement')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<{ items: unknown[] }>(`/api/v1/requirements/${id}/slices`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'orderIndex', 'modelTier', 'status'])
    })

  slice
    .command('create <id>')
    .description('create an execution slice for a requirement')
    .requiredOption('--title <title>', 'slice title')
    .option('--description <desc>', 'slice description')
    .option('--order <n>', 'slice order index')
    .option('--allow-parallel', 'allow this slice to run before earlier slices are terminal')
    .option('--model-tier <tier>', 'fast|standard|strong')
    .option('--tasks <ids>', 'comma-separated task IDs to assign')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/requirements/${id}/slices`, {
        title: opts.title,
        description: opts.description,
        orderIndex: opts.order !== undefined ? Number(opts.order) : undefined,
        allowParallel: Boolean(opts.allowParallel),
        modelTier: opts.modelTier,
        taskIds: opts.tasks ? String(opts.tasks).split(',').map((taskId) => taskId.trim()).filter(Boolean) : undefined,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  slice
    .command('update <sliceId>')
    .description('update an execution slice')
    .option('--title <title>', 'new title')
    .option('--description <desc>', 'new description')
    .option('--order <n>', 'slice order index')
    .option('--allow-parallel', 'allow this slice to run before earlier slices are terminal')
    .option('--sequential', 'require earlier slices to be terminal before this slice runs')
    .option('--model-tier <tier>', 'fast|standard|strong')
    .option('--status <status>', 'todo|in_progress|in_review|done|cancelled')
    .option('--summary <text>', 'result summary')
    .option('--tasks <ids>', 'comma-separated task IDs to assign')
    .option('--json', 'output raw JSON')
    .action(async (sliceId, opts) => {
      if (opts.allowParallel && opts.sequential) {
        throw new Error('Choose either --allow-parallel or --sequential')
      }
      const body: Record<string, unknown> = {}
      if (opts.title) body.title = opts.title
      if (opts.description !== undefined) body.description = opts.description
      if (opts.order !== undefined) body.orderIndex = Number(opts.order)
      if (opts.allowParallel) body.allowParallel = true
      if (opts.sequential) body.allowParallel = false
      if (opts.modelTier) body.modelTier = opts.modelTier
      if (opts.status) body.status = opts.status
      if (opts.summary !== undefined) body.resultSummary = opts.summary
      if (opts.tasks) body.taskIds = String(opts.tasks).split(',').map((taskId) => taskId.trim()).filter(Boolean)
      const data = await patch(`/api/v1/execution-slices/${sliceId}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  slice
    .command('delete <sliceId>')
    .description('delete an execution slice')
    .option('--json', 'output raw JSON')
    .action(async (sliceId, opts) => {
      const data = await del(`/api/v1/execution-slices/${sliceId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const repo = req.command('repo').description('manage Requirement repository workspace links')

  repo.command('list <id>').description('list repositories linked to a Requirement')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<unknown[]>(`/api/v1/requirements/${id}/repositories`)
      if (opts.json) return printJson(data)
      printTable(data.map((entry: any) => ({ ...entry.repository, ...entry.link })), ['repositoryId', 'canonicalKey', 'baseBranch', 'workingBranch', 'deliveryStatus'])
    })

  repo.command('add <id> <repositoryId>').description('add a repository to a Requirement workspace')
    .option('--base-branch <branch>', 'base branch')
    .option('--working-branch <branch>', 'working branch')
    .option('--json', 'output raw JSON')
    .action(async (id, repositoryId, opts) => {
      const data = await post(`/api/v1/requirements/${id}/repositories`, {
        repositoryId, baseBranch: opts.baseBranch, workingBranch: opts.workingBranch,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('remove <id> <repositoryId>').description('remove a repository after dependency guards')
    .option('--json', 'output raw JSON')
    .action(async (id, repositoryId, opts) => {
      const data = await del(`/api/v1/requirements/${id}/repositories/${repositoryId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('reopen <linkId>').description('explicitly reopen a terminal Requirement repository delivery')
    .requiredOption('--reason <reason>', 'audited reason for reopening the terminal delivery')
    .option('--json', 'output raw JSON')
    .action(async (linkId, opts) => {
      const data = await post(`/api/v1/requirement-repositories/${linkId}/reopen`, {
        reason: opts.reason,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
}
