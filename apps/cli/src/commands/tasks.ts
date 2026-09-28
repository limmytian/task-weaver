import { Command, Option } from 'commander'
import * as readline from 'readline/promises'
import { get, post, patch, del, ApiError } from '../client.js'
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

function summarizeTask(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    requirementId: row.requirementId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    updatedAt: row.updatedAt,
  }
}



function leaseFenceFromEnvironment() {
  const leaseGeneration = Number(process.env.TW_REQUIREMENT_LEASE_GENERATION)
  const daemonId = process.env.TW_DAEMON_ID
  return Number.isInteger(leaseGeneration) && leaseGeneration > 0 && daemonId
    ? { leaseGeneration, daemonId }
    : {}
}

export function registerTasks(program: Command): void {
  const task = program.command('task').description('manage tasks')

  task
    .command('list')
    .description('list filtered, paginated task summaries')
    .option('--project <id>', 'project ID')
    .option('--personal', 'list personal tasks for the current actor')
    .option('--status <status>', 'todo|in_progress|in_review|done|cancelled')
    .option('--assignee <id>', 'filter by assignee')
    .option('--req <requirementId>', 'filter by requirement')
    .option('--priority <priority>', 'low|medium|high|urgent')
    .option('--query <text>', 'search task title and description')
    .option('--completed-within-days <days>', 'include terminal tasks completed within N days', '7')
    .option('--page <n>', 'page number', '1')
    .option('--page-size <n>', 'items per page (summary default: 20; full default: 5)')
    .option('--full', 'include repository details; requires --json')
    .option('--json', 'output JSON with explicit view and pagination metadata')
    .action(async (opts) => {
      if (!opts.personal && !opts.project) {
        throw new Error('Either --project or --personal is required')
      }
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
      if (opts.assignee) params.set('assignee', opts.assignee)
      if (opts.req) params.set('requirementId', opts.req)
      if (opts.priority) params.set('priority', opts.priority)
      if (opts.query) params.set('q', opts.query)
      params.set('completedWithinDays', String(opts.completedWithinDays))
      const qs = `?${params}`
      const path = opts.personal
        ? `/api/v1/personal/tasks${qs}`
        : `/api/v1/projects/${opts.project}/tasks${qs}`
      const data = await get<ListResponse>(path)
      const result = normalizeList(data, page, pageSize)
      const items = opts.full ? result.items : result.items.map(summarizeTask)
      const meta = {
        view,
        isFull: Boolean(opts.full),
        omitted: opts.full ? [] : ['description', 'repositories'],
        page: result.page,
        pageSize: result.pageSize,
        pageCount: result.pageCount,
        total: result.total,
        nextPage: result.page < result.pageCount ? result.page + 1 : null,
        filters: {
          status: opts.status ?? null,
          assignee: opts.assignee ?? null,
          requirementId: opts.req ?? null,
          priority: opts.priority ?? null,
          query: opts.query ?? null,
          completedWithinDays: Number(opts.completedWithinDays),
        },
        detailCommand: 'tw task get <id> --json',
      }
      if (opts.json) return printJson({ items, meta })

      printTable(items, ['status', 'priority', 'title', 'assignee', 'updatedAt', 'id'])
      console.log('Summary view only; description and repository data are omitted.')
      console.log(`Page ${result.page}/${Math.max(result.pageCount, 1)} · ${result.total} tasks · use --page <n> or tw task get <id> --json`)
    })



  task
    .command('get <id>')
    .description('get task details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/tasks/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('create')
    .description('create a project or personal task')
    .option('--project <id>', 'project ID')
    .option('--req <requirementId>', 'requirement ID (required for project tasks)')
    .option('--personal', 'create a personal task for the current actor')
    .requiredOption('--title <title>', 'task title')
    .option('--description <desc>', 'task description')
    .option('--slice <id>', 'execution slice ID')
    .option('--priority <priority>', 'low|medium|high|urgent (default: medium)')
    .option('--assignee <id>', 'assignee ID')
    .option('--assignee-type <type>', 'human|agent')
    .option('--requested-ti-provider <provider>', 'requested Ti provider for assigned server-agent work')
    .option('--requested-ti-model <model>', 'requested Ti model for assigned server-agent work')
    .addOption(new Option('--requested-pi-provider <provider>').hideHelp())
    .addOption(new Option('--requested-pi-model <model>').hideHelp())
    .option('--branch-name <name>', 'git branch name for this task')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      if (!opts.personal && (!opts.project || !opts.req)) {
        throw new Error('Project tasks require --project and --req. Use --personal for personal tasks.')
      }
      const body = {
        requirementId: opts.req,
        executionSliceId: opts.slice,
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        assignee: opts.assignee,
        assigneeType: opts.assigneeType,
        requestedPiProvider: opts.requestedTiProvider ?? opts.requestedPiProvider,
        requestedPiModel: opts.requestedTiModel ?? opts.requestedPiModel,
        branchName: opts.branchName,
      }
      const path = opts.personal
        ? '/api/v1/personal/tasks'
        : `/api/v1/projects/${opts.project}/tasks`
      const data = await post(path, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('update <id>')
    .description('update task fields')
    .option('--title <title>', 'new title')
    .option('--description <desc>', 'new description')
    .option('--slice <id>', 'execution slice ID')
    .option('--clear-slice', 'remove task from its execution slice')
    .option('--assignee <id>', 'new assignee')
    .option('--assignee-type <type>', 'human|agent')
    .option('--priority <priority>', 'new priority')
    .option('--requested-ti-provider <provider>', 'requested Ti provider')
    .option('--requested-ti-model <model>', 'requested Ti model')
    .addOption(new Option('--requested-pi-provider <provider>').hideHelp())
    .addOption(new Option('--requested-pi-model <model>').hideHelp())
    .option('--branch-name <name>', 'git branch name for this task')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.title) body.title = opts.title
      if (opts.description) body.description = opts.description
      if (opts.slice) body.executionSliceId = opts.slice
      if (opts.clearSlice) body.executionSliceId = null
      if (opts.assignee) body.assignee = opts.assignee
      if (opts.assigneeType) body.assigneeType = opts.assigneeType
      if (opts.priority) body.priority = opts.priority
      const requestedProvider = opts.requestedTiProvider ?? opts.requestedPiProvider
      const requestedModel = opts.requestedTiModel ?? opts.requestedPiModel
      if (requestedProvider !== undefined) body.requestedPiProvider = requestedProvider
      if (requestedModel !== undefined) body.requestedPiModel = requestedModel
      if (opts.branchName !== undefined) body.branchName = opts.branchName
      const data = await patch(`/api/v1/tasks/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('status <id> <status>')
    .description('change task status')
    .option('--reason <reason>', 'reason for status change')
    .option('--force', 'skip dependency check')
    .option('--json', 'output raw JSON')
    .action(async (id, status, opts) => {
      const data = await patch(`/api/v1/tasks/${id}/status`, {
        status,
        reason: opts.reason,
        force: opts.force,
        ...leaseFenceFromEnvironment(),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('comment <id> <content>')
    .description('add a comment to a task')
    .option('--json', 'output raw JSON')
    .action(async (id, content, opts) => {
      const data = await post(`/api/v1/tasks/${id}/comments`, { content })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('note <id> <content>')
    .description('add a note to a task')
    .option('--pin', 'pin the note')
    .option('--json', 'output raw JSON')
    .action(async (id, content, opts) => {
      const data = await post(`/api/v1/tasks/${id}/notes`, { content, pinned: opts.pin ?? false })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('claim <id>')
    .description('claim a task for exclusive work')
    .option('--duration <minutes>', 'lease duration in minutes (default: 30)', '30')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/tasks/${id}/claim`, {
        action: 'claim',
        durationMinutes: Number(opts.duration),
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('delete <id>')
    .description('delete (cancel) a task')
    .option('--force', 'skip confirmation prompt')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (!opts.force) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Delete task ${id}? This action cannot be undone. [y/N] `)
        rl.close()
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.')
          process.exit(0)
        }
      }
      const data = await patch(`/api/v1/tasks/${id}/status`, { status: 'cancelled' })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  task
    .command('release <id>')
    .description('release a claimed task')
    .option('--reason <reason>', 'reason for release')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      try {
        const data = await post(`/api/v1/tasks/${id}/release`, {
          reason: opts.reason,
        })
        if (opts.json) return printJson(data)
        printKv(data as Record<string, unknown>)
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && err.message === 'Task is not currently claimed') {
          if (opts.json) {
            return printJson({ released: true, note: 'Task is not currently claimed (possibly already auto-released)' })
          }
          console.log(`Note: Task ${id} is not currently claimed (possibly already auto-released). No release action needed.`)
          return
        }
        throw err
      }
    })

  const dep = task.command('dep').description('manage task dependencies')

  dep
    .command('list <id>')
    .description('list blockers and dependents for a task')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/tasks/${id}`)
      const dependencies = ((data as any).dependencies ?? []).map((dep: any) => ({
        id: dep.id,
        dependsOnTaskId: dep.dependsOnTaskId,
        title: dep.dependsOn?.title,
        status: dep.dependsOn?.status,
        type: dep.type,
        description: dep.description,
      }))
      const dependents = ((data as any).dependents ?? []).map((dep: any) => ({
        id: dep.id,
        taskId: dep.taskId,
        title: dep.task?.title,
        status: dep.task?.status,
        type: dep.type,
        description: dep.description,
      }))
      if (opts.json) return printJson({ dependencies, dependents })
      console.log('Dependencies:')
      printTable(dependencies as Record<string, unknown>[], ['id', 'dependsOnTaskId', 'title', 'status', 'type', 'description'])
      console.log('Dependents:')
      printTable(dependents as Record<string, unknown>[], ['id', 'taskId', 'title', 'status', 'type', 'description'])
    })

  dep
    .command('add <id> <dependsOnTaskId>')
    .description('add a dependency from one task to another')
    .option('--type <type>', 'blocks|related (default: blocks)', 'blocks')
    .option('--description <desc>', 'dependency description')
    .option('--json', 'output raw JSON')
    .action(async (id, dependsOnTaskId, opts) => {
      const data = await post(`/api/v1/tasks/${id}/dependencies`, {
        dependsOnTaskId,
        type: opts.type,
        description: opts.description,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  dep
    .command('remove <id> <depId>')
    .description('remove a task dependency')
    .option('--json', 'output raw JSON')
    .action(async (id, depId, opts) => {
      const data = await del(`/api/v1/tasks/${id}/dependencies/${depId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const repo = task.command('repo').description('manage optional Task repository scope hints')

  repo.command('list <id>').description('list Task repository scope hints')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<unknown[]>(`/api/v1/tasks/${id}/repositories`)
      if (opts.json) return printJson(data)
      printTable(data.map((entry: any) => ({ ...entry.repository, ...entry.link })), ['repositoryId', 'canonicalKey', 'provider', 'status'])
      if (data.length === 0) console.log('Repository scope is unspecified; the full Requirement workspace remains available.')
    })

  repo.command('add <id> <repositoryId>').description('add a Task repository scope hint')
    .option('--add-to-requirement', 'explicitly expand the Requirement workspace first')
    .option('--base-branch <branch>', 'base branch when expanding the Requirement')
    .option('--working-branch <branch>', 'working branch when expanding the Requirement')
    .option('--json', 'output raw JSON')
    .action(async (id, repositoryId, opts) => {
      const data = await post(`/api/v1/tasks/${id}/repositories`, {
        repositoryId,
        addToRequirement: opts.addToRequirement ?? false,
        baseBranch: opts.baseBranch,
        workingBranch: opts.workingBranch,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('remove <id> <repositoryId>').description('remove a Task repository scope hint')
    .option('--json', 'output raw JSON')
    .action(async (id, repositoryId, opts) => {
      const data = await del(`/api/v1/tasks/${id}/repositories/${repositoryId}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
}
