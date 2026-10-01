import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import {
  agentUsageQuerySchema,
  reportPiAgentUsageSchema,
} from '@task-weaver/contracts'
import { get, post } from '../client.js'
import { printJson, printTable, printKv } from '../output.js'

export function registerAgentUsage(program: Command) {
  const usage = program
    .command('usage')
    .description('inspect whole-process agent token usage and coverage')
  for (const command of ['runs', 'summary']) {
    usage
      .command(command)
      .requiredOption('--project <id>', 'project scope')
      .option('--req <id>', 'requirement scope')
      .option(
        '--task <id>',
        'task scope (shared requirement runs are excluded)',
      )
      .option('--since <date>', 'inclusive process start timestamp (ISO 8601)')
      .option('--until <date>', 'exclusive process start timestamp (ISO 8601)')
      .option('--phase <phase>', 'execution|review|rework')
      .option('--coverage <coverage>', 'complete|partial|unknown')
      .option('--limit <number>', 'page size', '25')
      .option('--offset <number>', 'page offset', '0')
      .option('--json', 'output JSON')
      .action(async (opts) => {
        const query = agentUsageQuerySchema.parse({
          projectId: opts.project,
          requirementId: opts.req,
          taskId: opts.task,
          since: opts.since,
          until: opts.until,
          phase: opts.phase,
          completeness: opts.coverage,
          limit: opts.limit,
          offset: opts.offset,
        })
        const params = new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        )
        const data: any = await get(
          `/api/v1/agent-usage/${command === 'runs' ? 'runs' : 'summary'}?${params}`,
        )
        if (opts.json) return printJson(data)
        if (command === 'summary') return printKv(data)
        printTable(
          data.items.map((run: any) => ({
            process: run.processId,
            phase: run.phase,
            outcome: run.outcome,
            input: run.summary.inputTokens ?? 'Unknown',
            output: run.summary.outputTokens ?? 'Unknown',
            coverage: run.summary.completeness,
          })),
          ['process', 'phase', 'outcome', 'input', 'output', 'coverage'],
        )
        console.log(
          `${data.total} registered processes; offset ${data.offset}. Unregistered processes are outside coverage.`,
        )
      })
  }
  usage
    .command('run <id>')
    .requiredOption('--project <id>', 'project scope')
    .option('--json', 'output JSON')
    .action(async (id, opts) => {
      const data: any = await get(
        `/api/v1/agent-usage/runs/${encodeURIComponent(id)}?projectId=${encodeURIComponent(opts.project)}`,
      )
      if (opts.json) return printJson(data)
      printKv({ ...data, ...data.summary })
    })
  usage
    .command('report-ti <runId>')
    .requiredOption(
      '--file <path>',
      'compact whole-process snapshot JSON; no transcript or model calls',
    )
    .option('--json', 'output JSON')
    .action(async (runId, opts) => {
      const body = reportPiAgentUsageSchema.parse(
        JSON.parse(readFileSync(opts.file, 'utf8')),
      )
      const data: any = await post(
        `/api/v1/pi-agent/runs/${encodeURIComponent(runId)}/usage`,
        body,
      )
      if (opts.json) return printJson(data)
      printKv({
        processId: data.processId,
        revision: data.revision,
        completeness: data.summary.completeness,
      })
    })
}
