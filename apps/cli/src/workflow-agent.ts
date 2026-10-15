import { workflowAgentResultSchema, type WorkflowAgentResult } from '@task-weaver/contracts'
import { runMeteredAgent } from './agent-usage.js'
import { createTaskWorkerAccess } from './task-worker-access.js'
import { ExecutorResourceBlocked } from './executor-availability.js'
import type { Config } from './config.js'

export const WORKFLOW_RESULT_PROTOCOL = `Return exactly one final result line with valid JSON:
WORKFLOW_RESULT: {"decision":"complete","reason":"What was verified or performed","checks":[{"name":"configured check","status":"passed","summary":"Observed evidence"}]}
Use changes_requested for output findings that need executor rework, or failed when the action cannot be completed. Only include checks for the current stage, each with status passed or failed. Omit pending or future-stage checks. Report each required check explicitly. Never claim a check passed without inspecting evidence. Do not change the requirement status or advance its workflow yourself.`

export function parseWorkflowAgentResult(output: string): WorkflowAgentResult {
  const texts: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') { if (value.includes('WORKFLOW_RESULT:')) texts.push(value); return }
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const line of output.split(/\r?\n/)) {
    try { collect(JSON.parse(line)) } catch { texts.push(line) }
  }
  const results = texts.flatMap((text) => text.split(/\r?\n/).filter((line) => line.trim().startsWith('WORKFLOW_RESULT:')))
  if (results.length !== 1) throw new Error('Agent must return exactly one workflow result')
  return workflowAgentResultSchema.parse(JSON.parse(results[0]!.trim().slice('WORKFLOW_RESULT:'.length).trim()))
}

export async function runWorkflowAgent(options: {
  config: Config
  daemonId: string
  requirement: { id: string; projectId: string }
  runId: string
  leaseGeneration: number
  workerIndex: number
  stage: 'delivery' | 'acceptance' | 'integration'
  tool: string
  argv: string[]
  cwd: string
  signal: AbortSignal
}): Promise<WorkflowAgentResult> {
  const access = await createTaskWorkerAccess({
    config: options.config, daemonId: options.daemonId, requirementId: options.requirement.id,
    runId: options.runId, leaseGeneration: options.leaseGeneration, workerIndex: options.workerIndex, signal: options.signal,
  })
  try {
    const child = await runMeteredAgent(options.tool, options.argv, {
      cwd: options.cwd, env: access.environment, signal: access.signal,
      timeoutMs: 60 * 60_000, maxOutputBytes: 20 * 1024 * 1024, redact: access.redact,
    }, {
      daemonId: options.daemonId, runId: options.runId, leaseGeneration: options.leaseGeneration,
      workerIndex: options.workerIndex, projectId: options.requirement.projectId,
      requirementId: options.requirement.id, agent: options.tool,
      phase: options.stage === 'acceptance' ? 'review' : options.stage === 'delivery' ? 'execution' : 'integration',
    })
    if (child.resourceInterruption) throw new ExecutorResourceBlocked(child.resourceInterruption)
    if (!child.ok) return { decision: 'failed', reason: `Workflow agent exited with status ${child.status ?? 'unknown'}`, checks: [] }
    try { return parseWorkflowAgentResult(child.stdout) } catch {
      return { decision: 'failed', reason: 'Agent response did not contain exactly one valid workflow result.', checks: [] }
    }
  } finally { await access.close() }
}
