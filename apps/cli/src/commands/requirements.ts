import { Command } from 'commander'
import * as readline from 'readline/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { requirementWorkflowSchema, reconcileHumanRepositoryDeliverySchema } from '@task-weaver/contracts'
import { loadConfig } from '../config.js'
import { localWorkflowOutputPath, probeWorkflowArtifact, storeWorkflowArtifact, type LocalWorkflowOutput } from '../workflow-artifacts.js'
import { cleanupRequirementWorktrees, normalizeRequirementRepositoryEntries } from '../repository-workspace.js'
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

  req.command('revalidate <id>').description('record human verification of historical evidence after a plan change')
    .requiredOption('--reason <text>', 'evidence inspected and verification reason').requiredOption('--revision <number>', 'latest inspected planning revision').option('--json', 'output JSON')
    .action(async (id, opts) => printJson(await post(`/api/v1/requirements/${id}/execution-revalidation`, { reason: opts.reason, expectedPlanRevision: Number(opts.revision) })))
  req.command('recover <id> <control-id>').description('authorize a fresh recovery after inspecting uncertain outcomes and required inputs')
    .requiredOption('--reason <text>', 'verified outcomes, available inputs and recovery decision').requiredOption('--revision <number>', 'latest inspected plan revision').option('--json', 'output JSON')
    .action(async (id, controlId, opts) => printJson(await post(`/api/v1/requirements/${id}/execution-recovery`, { controlId, reason: opts.reason, expectedPlanRevision: Number(opts.revision) })))
  const output = req.command('output').description('manage requirement delivery outputs')
  output.command('list <requirement-id>')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<unknown[]>(`/api/v1/requirements/${id}/workflow-outputs`)
      if (opts.json) return printJson(data)
      printTable(data as Record<string, unknown>[], ['type', 'summary', 'url', 'relativePath', 'id'])
    })
  output.command('register <requirement-id>')
    .requiredOption('--type <type>', 'comment|attachment|url|local|git_branch|git_pr')
    .option('--reference <id>', 'platform comment or attachment ID')
    .option('--url <url>', 'URL for a URL or Git PR output')
    .option('--node <id>', 'stable node ID for a local output')
    .option('--path <path>', 'path relative to the local artifact root')
    .option('--file <path>', 'copy a local file to durable node storage and register its checksum')
    .option('--size <bytes>', 'local output size in bytes')
    .option('--sha256 <hash>', 'local output SHA-256 checksum')
    .option('--repository-link <id>', 'requirement repository link ID')
    .option('--task <id>', 'source task ID')
    .option('--slice <id>', 'source execution slice ID')
    .option('--summary <text>', 'output summary')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (opts.file && opts.type !== 'local') throw new Error('--file requires --type local')
      if (opts.file && (opts.path || opts.node || opts.size || opts.sha256)) throw new Error('--file cannot be combined with manual local metadata')
      let local: { nodeId: string; relativePath: string; sizeBytes: number; sha256: string } | undefined
      if (opts.file) {
        const config = loadConfig()
        if (!config.nodeId) throw new Error('Node identity is unavailable')
        local = await storeWorkflowArtifact(id, opts.file, config.nodeId)
      }
      const data = await post(`/api/v1/requirements/${id}/workflow-outputs`, {
        type: opts.type, referenceId: opts.reference, url: opts.url,
        nodeId: local?.nodeId ?? opts.node, relativePath: local?.relativePath ?? opts.path,
        sizeBytes: local?.sizeBytes ?? (opts.size === undefined ? undefined : Number(opts.size)),
        sha256: local?.sha256 ?? opts.sha256, requirementRepositoryId: opts.repositoryLink,
        taskId: opts.task, executionSliceId: opts.slice, summary: opts.summary,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  output.command('verify <requirement-id> <output-id>')
    .option('--daemon-id <id>', 'registered daemon reporting availability')
    .option('--json', 'output raw JSON')
    .action(async (id, outputId, opts) => {
      const config = loadConfig()
      const outputs = await get<LocalWorkflowOutput[]>(`/api/v1/requirements/${id}/workflow-outputs`)
      const target = outputs.find((entry) => entry.id === outputId && entry.type === 'local')
      if (!target) throw new Error('Local output not found')
      const probe = await probeWorkflowArtifact(target, config.nodeId)
      const data = await post(`/api/v1/requirements/${id}/workflow-output-availability`, { outputId, nodeId: config.nodeId, daemonId: opts.daemonId, ...probe })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  output.command('retire <requirement-id> <output-id>')
    .description('retire an output after retention and all consumer work have finished')
    .option('--delete-local', 'delete verified local bytes after retirement is authorized')
    .option('--json', 'output raw JSON')
    .action(async (id, outputId, opts) => {
      let localPath: string | undefined
      if (opts.deleteLocal) {
        const outputs = await get<LocalWorkflowOutput[]>(`/api/v1/requirements/${id}/workflow-outputs`)
        const output = outputs.find((candidate) => candidate.id === outputId && candidate.type === 'local')
        if (!output) throw new Error('Local output not found')
        const probe = await probeWorkflowArtifact(output, loadConfig().nodeId)
        if (probe.availability !== 'available') throw new Error(probe.reason)
        localPath = localWorkflowOutputPath(output.relativePath!)
      }
      const data = await post(`/api/v1/requirements/${id}/workflow-output-retire`, { outputId })
      if (localPath) unlinkSync(localPath)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req.command('workspace').description('manage node-local requirement workspaces')
    .command('cleanup <id>')
    .description('remove clean Git worktrees after retention and all consumers have finished')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const policy = await get<{ canCleanupWorktrees: boolean; activeConsumers: number; worktreeRetainUntil: string }>(`/api/v1/requirements/${id}/workflow-cleanup`)
      if (!policy.canCleanupWorktrees) throw new Error(`Workspace must be terminal, have no active consumers, and be retained until ${policy.worktreeRetainUntil}; active consumers: ${policy.activeConsumers}`)
      const repositories = await get<unknown[]>(`/api/v1/requirements/${id}/repositories`)
      const result = await cleanupRequirementWorktrees(loadConfig(), id, normalizeRequirementRepositoryEntries(repositories))
      if (opts.json) return printJson(result)
      printKv(result)
    })

  const input = req.command('input').description('declare outputs needed by downstream work')
  input.command('list <requirement-id>').option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get<Record<string, unknown>[]>(`/api/v1/requirements/${id}/workflow-inputs`)
      if (opts.json) return printJson(data)
      printTable(data, ['id', 'outputId', 'taskId', 'executionSliceId'])
    })
  input.command('add <requirement-id> <output-id>')
    .option('--task <id>', 'limit dependency to one task')
    .option('--slice <id>', 'limit dependency to one execution slice')
    .option('--json', 'output raw JSON')
    .action(async (id, outputId, opts) => {
      const data = await post(`/api/v1/requirements/${id}/workflow-inputs`, { outputId, taskId: opts.task, executionSliceId: opts.slice })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  req.command('advance <id>')
    .requiredOption('--stage <stage>', 'delivery|acceptance|integration')
    .requiredOption('--reason <text>', 'reason for the decision')
    .requiredOption('--revision <number>', 'expected workflow state revision')
    .option('--decision <decision>', 'complete|changes_requested|failed|retry', 'complete')
    .option('--checks-file <path>', 'JSON array of acceptance checks')
    .option('--lease-generation <number>', 'requirement lease generation')
    .option('--daemon-id <id>', 'daemon holding the requirement lease')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/requirements/${id}/workflow-advance`, {
        stage: opts.stage, reason: opts.reason, decision: opts.decision,
        expectedRevision: Number(opts.revision),
        checks: opts.checksFile ? JSON.parse(readFileSync(opts.checksFile, 'utf8')) : [],
        leaseGeneration: opts.leaseGeneration === undefined ? undefined : Number(opts.leaseGeneration),
        daemonId: opts.daemonId,
      })
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
    .option('--status <status>', 'draft|approved|in_progress (default: draft)')
    .option('--model-tier <tier>', 'fast|standard|strong (default: standard)')
    .option('--branch-name <name>', 'git branch name for this requirement')
    .option('--workflow <preset>', 'workflow preset: basic|comment|attachment|url|local|git_branch|git_pr')
    .option('--workflow-file <path>', 'JSON workflow definition; mutually exclusive with --workflow')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      if (opts.workflow && opts.workflowFile) throw new Error('Choose either --workflow or --workflow-file')
      const data = await post(`/api/v1/projects/${opts.project}/requirements`, {
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        status: opts.status,
        modelTier: opts.modelTier,
        branchName: opts.branchName,
        workflowPreset: opts.workflow,
        workflow: opts.workflowFile ? requirementWorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowFile, 'utf8'))) : undefined,
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
    .option('--workflow <preset>', 'replace workflow with a preset')
    .option('--workflow-file <path>', 'replace workflow with a JSON definition')
    .option('--recovery-policy <json>', 'explicit retrySafe, maxAttempts and graceMs policy')
    .option('--reason <text>', 'audit reason for this update (1-2000 characters)')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (opts.workflow && opts.workflowFile) throw new Error('Choose either --workflow or --workflow-file')
      const body: Record<string, unknown> = {}
      if (opts.reason !== undefined) body.reason = opts.reason
      if (opts.title) body.title = opts.title
      if (opts.description) body.description = opts.description
      if (opts.status) body.status = opts.status
      if (opts.priority) body.priority = opts.priority
      if (opts.modelTier) body.modelTier = opts.modelTier
      if (opts.branchName !== undefined) body.branchName = opts.branchName
      if (opts.workflow) body.workflowPreset = opts.workflow
      if (opts.recoveryPolicy) body.recoveryPolicy = JSON.parse(opts.recoveryPolicy)
      if (opts.workflowFile) body.workflow = requirementWorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowFile, 'utf8')))
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

  repo.command('sync-pr <linkId>').description('register or synchronize a pull request using trusted server verification (human only)')
    .requiredOption('--url <url>', 'pull request URL for the linked repository')
    .requiredOption('--reason <text>', 'audited reason for reconciliation')
    .requiredOption('--revision <number>', 'current externalSyncRevision')
    .requiredOption('--updated-at <timestamp>', 'current delivery updatedAt')
    .requiredOption('--request-id <uuid>', 'stable idempotency key; reuse for an exact retry')
    .option('--json', 'output raw JSON')
    .action(async (linkId, opts) => {
      const data = await post(`/api/v1/requirement-repositories/${linkId}/human-sync`, reconcileHumanRepositoryDeliverySchema.parse({
        pullRequestUrl: opts.url, reason: opts.reason, expectedRevision: Number(opts.revision),
        expectedUpdatedAt: opts.updatedAt, idempotencyKey: opts.requestId,
      }))
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('sync-direct <linkId>').description('verify a delivered commit is contained in the target branch without a PR (human only)')
    .requiredOption('--commit <sha>', 'full delivered commit SHA to verify against the configured target branch')
    .requiredOption('--reason <text>', 'audited reason for reconciliation')
    .requiredOption('--revision <number>', 'current externalSyncRevision')
    .requiredOption('--updated-at <timestamp>', 'current delivery updatedAt')
    .requiredOption('--request-id <uuid>', 'stable idempotency key; reuse for an exact retry')
    .option('--json', 'output raw JSON')
    .action(async (linkId, opts) => {
      const data = await post(`/api/v1/requirement-repositories/${linkId}/human-sync`, reconcileHumanRepositoryDeliverySchema.parse({
        commit: opts.commit, reason: opts.reason, expectedRevision: Number(opts.revision),
        expectedUpdatedAt: opts.updatedAt, idempotencyKey: opts.requestId,
      }))
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
