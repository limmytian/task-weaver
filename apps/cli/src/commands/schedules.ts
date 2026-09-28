import { Command, Option } from 'commander'
import { del, get, patch, post } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'

function scheduleBody(opts: any) {
  const body: Record<string, unknown> = {}
  if (opts.req) body.requirementId = opts.req
  if (opts.targetScope) body.targetScope = opts.targetScope
  if (opts.kind) body.kind = opts.kind
  if (opts.title) body.title = opts.title
  if (opts.description) body.description = opts.description
  if (opts.timezone) body.timezone = opts.timezone
  if (opts.startsAt) body.startsAt = opts.startsAt
  if (opts.endsAt) body.endsAt = opts.endsAt
  if (opts.nextRunAt) body.nextRunAt = opts.nextRunAt
  if (opts.recurrenceSyntax) body.recurrenceSyntax = opts.recurrenceSyntax
  if (opts.recurrenceRule) body.recurrenceRule = opts.recurrenceRule
  if (opts.catchUpPolicy) body.catchUpPolicy = opts.catchUpPolicy
  if (opts.expiryWindowMinutes) body.expiryWindowMinutes = Number(opts.expiryWindowMinutes)
  if (opts.maxCatchUpRuns) body.maxCatchUpRuns = Number(opts.maxCatchUpRuns)
  if (opts.autoRun !== undefined) body.autoRun = opts.autoRun
  if (opts.assignedExecutor) body.assignedExecutor = opts.assignedExecutor
  if (opts.assignedExecutorType) body.assignedExecutorType = opts.assignedExecutorType
  const requestedProvider = opts.requestedTiProvider ?? opts.requestedPiProvider
  const requestedModel = opts.requestedTiModel ?? opts.requestedPiModel
  if (requestedProvider) body.requestedPiProvider = requestedProvider
  if (requestedModel) body.requestedPiModel = requestedModel

  const taskTemplate: Record<string, unknown> = {}
  if (opts.taskTitle) taskTemplate.title = opts.taskTitle
  if (opts.taskDescription) taskTemplate.description = opts.taskDescription
  if (opts.taskPriority) taskTemplate.priority = opts.taskPriority
  if (Object.keys(taskTemplate).length > 0) body.taskTemplate = taskTemplate
  return body
}

export function registerSchedules(program: Command): void {
  const schedule = program.command('schedule').description('manage scheduled and recurring task generation')

  schedule
    .command('list')
    .description('list project schedules')
    .requiredOption('--project <id>', 'project ID')
    .option('--status <status>', 'active|paused|archived')
    .option('--include-archived', 'include archived schedules')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.status) params.set('status', opts.status)
      if (opts.includeArchived) params.set('includeArchived', 'true')
      const qs = params.toString() ? `?${params}` : ''
      const data = await get(`/api/v1/projects/${opts.project}/schedules${qs}`)
      if (opts.json) return printJson(data)
      printTable(data as Record<string, unknown>[], ['id', 'title', 'kind', 'status', 'nextRunAt'])
    })

  schedule
    .command('get <id>')
    .description('get schedule details')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/schedules/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  schedule
    .command('create')
    .description('create a one-off or recurring schedule')
    .requiredOption('--project <id>', 'project ID')
    .requiredOption('--req <id>', 'requirement ID for generated tasks')
    .requiredOption('--kind <kind>', 'one_off|recurring')
    .requiredOption('--title <title>', 'schedule title')
    .requiredOption('--starts-at <iso>', 'first planned run time')
    .requiredOption('--task-title <title>', 'generated task title')
    .option('--description <text>', 'schedule description')
    .option('--timezone <zone>', 'IANA timezone', 'UTC')
    .option('--ends-at <iso>', 'schedule end time')
    .option('--next-run-at <iso>', 'override next due time')
    .option('--recurrence-syntax <syntax>', 'rrule|cron')
    .option('--recurrence-rule <rule>', 'RRULE body or cron expression')
    .option('--catch-up-policy <policy>', 'none|latest|all', 'latest')
    .option('--expiry-window-minutes <n>', 'skip occurrences older than this window')
    .option('--max-catch-up-runs <n>', 'maximum backfill runs per acquisition')
    .option('--task-description <text>', 'generated task description')
    .option('--task-priority <priority>', 'low|medium|high|urgent', 'medium')
    .option('--auto-run', 'generated task should be picked up automatically')
    .option('--assigned-executor <id>', 'executor assignment for generated tasks')
    .option('--assigned-executor-type <type>', 'human|agent')
    .option('--requested-ti-provider <provider>', 'requested Ti provider')
    .option('--requested-ti-model <model>', 'requested Ti model')
    .addOption(new Option('--requested-pi-provider <provider>').hideHelp())
    .addOption(new Option('--requested-pi-model <model>').hideHelp())
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post(`/api/v1/projects/${opts.project}/schedules`, scheduleBody(opts))
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  schedule
    .command('update <id>')
    .description('update schedule fields')
    .option('--status <status>', 'active|paused|archived')
    .option('--title <title>', 'schedule title')
    .option('--description <text>', 'schedule description')
    .option('--next-run-at <iso>', 'next due time')
    .option('--catch-up-policy <policy>', 'none|latest|all')
    .option('--expiry-window-minutes <n>', 'skip occurrences older than this window')
    .option('--max-catch-up-runs <n>', 'maximum backfill runs per acquisition')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body = scheduleBody(opts)
      if (opts.status) body.status = opts.status
      const data = await patch(`/api/v1/schedules/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  schedule
    .command('archive <id>')
    .description('archive a schedule')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await del(`/api/v1/schedules/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  schedule
    .command('run-now <id>')
    .description('create a generated task for this schedule immediately')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/schedules/${id}/run-now`, {})
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  schedule
    .command('runs <id>')
    .description('list schedule run history')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/schedules/${id}/runs`)
      if (opts.json) return printJson(data)
      printTable(data as Record<string, unknown>[], ['id', 'plannedFor', 'status', 'generatedTaskId', 'skippedReason'])
    })

  schedule
    .command('acquire-due')
    .description('process due schedules and create generated tasks')
    .option('--project <id>', 'restrict to project')
    .option('--limit <n>', 'maximum schedules to process', '20')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/schedules/acquire-due', {
        projectId: opts.project,
        limit: Number(opts.limit),
      })
      if (opts.json) return printJson(data)
      printJson(data)
    })
}
