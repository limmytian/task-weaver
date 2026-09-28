import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { post } from '../client.js'
import { printJson, printTable } from '../output.js'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load(input: string): unknown }

interface PlanApplyResult {
  dryRun: boolean;
  summary: Record<string, unknown>;
  refs: {
    requirements: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    slices: Array<Record<string, unknown>>;
    documents: Array<Record<string, unknown>>;
  };
  warnings?: string[];
}

export function registerPlans(program: Command): void {
  const plan = program.command('plan').description('validate and apply project plan files')

  plan
    .command('validate')
    .description('validate a plan file without writing changes')
    .requiredOption('-f, --file <path>', 'plan file path (.json, .yaml, or .yml)')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const result = await submitPlanFile(opts.file, true)
      if (opts.json) return printJson(result)
      printPlanResult(result, 'Plan is valid.')
    })

  plan
    .command('apply')
    .description('apply a plan file atomically')
    .requiredOption('-f, --file <path>', 'plan file path (.json, .yaml, or .yml)')
    .option('--dry-run', 'validate and preview without writing changes')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const result = await submitPlanFile(opts.file, Boolean(opts.dryRun))
      if (opts.json) return printJson(result)
      printPlanResult(result, result.dryRun ? 'Plan is valid.' : 'Plan applied.')
    })
}

async function submitPlanFile(filePath: string, dryRun: boolean) {
  const absolutePath = path.resolve(process.cwd(), filePath)
  const plan = loadPlanFile(absolutePath)
  return post<PlanApplyResult>('/api/v1/plans/apply', { dryRun, plan })
}

function loadPlanFile(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8')
  const ext = path.extname(filePath).toLowerCase()
  const parsed = ext === '.yaml' || ext === '.yml'
    ? yaml.load(raw)
    : JSON.parse(raw)
  return resolveContentFiles(parsed, path.dirname(filePath))
}

function resolveContentFiles(value: unknown, baseDir: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveContentFiles(item, baseDir))
  }
  if (!value || typeof value !== 'object') return value

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(input)) {
    if (key === 'contentFile') continue
    output[key] = resolveContentFiles(child, baseDir)
  }

  if (typeof input.contentFile === 'string') {
    if (output.content !== undefined) {
      throw new Error('A document cannot set both content and contentFile')
    }
    output.content = readFileSync(path.resolve(baseDir, input.contentFile), 'utf8')
  }

  return output
}

function printPlanResult(result: PlanApplyResult, title: string) {
  console.log(title)
  printSummary(result.summary)

  const warnings = result.warnings ?? []
  if (warnings.length > 0) {
    console.log('Warnings:')
    for (const warning of warnings) console.log(`- ${warning}`)
  }

  printRefs('Requirements', result.refs.requirements)
  printRefs('Tasks', result.refs.tasks)
  printRefs('Slices', result.refs.slices)
  printRefs('Documents', result.refs.documents)
}

function printSummary(summary: Record<string, unknown>) {
  const rows = Object.entries(summary).map(([entity, value]) => {
    if (typeof value === 'number') return { entity, count: value }
    return { entity, ...(value as Record<string, unknown>) }
  })
  console.log('Summary:')
  printTable(rows, ['entity', 'create', 'reuse', 'count'])
}

function printRefs(title: string, refs: Array<Record<string, unknown>>) {
  if (refs.length === 0) return
  console.log(title + ':')
  printTable(refs, ['key', 'id', 'existing', 'title'])
}
