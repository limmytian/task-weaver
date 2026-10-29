import { requirementWorkflowSchema, workflowNeedsWorktree } from '@task-weaver/contracts'
import { throwIfCancelled } from './daemon-lifecycle.js'
import type { LeaseSupervisor } from './lease-supervisor.js'
import type { Config } from './config.js'
import type { WorkerState, RequirementLane } from './daemon-worker-types.js'
import { provisionCompositeWorkspace, finalizeCompositeWorkspace } from './repository-workspace.js'
import { runWorkflowAgent, WORKFLOW_RESULT_PROTOCOL } from './workflow-agent.js'
import { probeWorkflowArtifact, type LocalWorkflowOutput } from './workflow-artifacts.js'

interface DeliveryWorkerDependencies {
  daemonId: string
  cliConfig: Config
  extraWorkerPrompt?: string
  once?: boolean
  workers: WorkerState[]
  leaseSupervisor: Pick<LeaseSupervisor, 'assertHealthy' | 'unregister'>
  daemonGet: <T>(path: string) => Promise<T>
  daemonPost: <T>(path: string, body: unknown) => Promise<T>
  daemonPatch: <T>(path: string, body: unknown) => Promise<T>
  selectTool: (tags: string[], serverSelection?: string | null) => string | null
  buildArgv: (tool: string, prompt: string, cwd: string) => string[]
  verifyLocalWorkflowOutputs: (outputs: LocalWorkflowOutput[], config: Config, report: (output: LocalWorkflowOutput, probe: Awaited<ReturnType<typeof probeWorkflowArtifact>>) => Promise<unknown>, signal?: AbortSignal) => Promise<void>
  reportDaemonStatus: (status: 'idle' | 'busy' | 'offline') => Promise<unknown>
  stopDaemon: (status: 'idle' | 'busy' | 'offline', exitCode: number) => Promise<void>
  resetBackoff: (worker: WorkerState) => void
  schedulePoll: (worker: WorkerState) => void
}

/** Owns the delivery-stage attempt; the command retains process scheduling and lease supervision. */
export function createDeliveryWorkerRunner(dependencies: DeliveryWorkerDependencies) {
  const { daemonId, cliConfig, extraWorkerPrompt, once, workers, leaseSupervisor,
    daemonGet, daemonPost, daemonPatch, selectTool, buildArgv, verifyLocalWorkflowOutputs,
    reportDaemonStatus, stopDaemon, resetBackoff, schedulePoll } = dependencies
  return async (w: WorkerState, lane: RequirementLane, signal: AbortSignal): Promise<void> => {
    const requirement = lane.requirement
    const workflow = requirementWorkflowSchema.parse(requirement.workflow)
    if (workflow.integration.target && ['git_provider', 'git_direct'].includes(workflow.integration.method) && lane.repositories.some((entry) => entry.link.baseBranch !== workflow.integration.target)) throw new Error('Git integration target must match every repository base branch')
    const fence = { daemonId, leaseGeneration: lane.leaseGeneration, runId: lane.runId }
    const active = () => { throwIfCancelled(signal); leaseSupervisor.assertHealthy(String(w.index)) }
    const patchDelivery = async (linkId: string, fields: Record<string, unknown>) => {
      active()
      return daemonPatch(`/api/v1/requirement-repositories/${linkId}/delivery`, { ...fields, ...fence })
    }
    w.currentRequirementId = requirement.id
    w.activeProcess = true
    w.currentTaskId = null
    w.requirementTitle = requirement.title
    w.startedAt = new Date().toISOString()
    await reportDaemonStatus('busy')
    let succeeded = false
    try {
      const workspace = await provisionCompositeWorkspace({ assertAuthority: async () => { await daemonPost(`/api/v1/daemons/${daemonId}/execution-authority`, { requirementId: requirement.id, ...fence }) }, executionRunId: lane.runId,
        config: cliConfig, requirement, executionSlice: lane.executionSlice,
        entries: workflowNeedsWorktree(workflow) ? lane.repositories : [], updateDelivery: patchDelivery, includeDeliveredRepositories: true, signal,
      })
      w.worktreePath = workspace.rootPath
      let outputs = await daemonGet<any[]>(`/api/v1/requirements/${requirement.id}/workflow-outputs`)
      outputs = outputs.filter((output) => output.workflowRevision === requirement.workflowRevision)
      await verifyLocalWorkflowOutputs(outputs, cliConfig,
        (output, probe) => daemonPost(`/api/v1/requirements/${output.requirementId}/workflow-output-availability`, { outputId: output.id, nodeId: cliConfig.nodeId, daemonId, ...probe }), signal)
      const gitDelivery = ['git_branch', 'git_pr'].includes(workflow.delivery.method)
      const missingOutput = workflow.delivery.method !== 'none' && !gitDelivery && !outputs.some((output) => output.type === workflow.delivery.method)
      let result = { decision: 'complete' as 'complete' | 'changes_requested' | 'failed', reason: 'Delivery evidence is ready; no extra instructions are configured.', checks: [] as Array<{ name: string; status: 'passed' | 'failed' }> }
      if (workflow.delivery.mode !== 'skip' && (workflow.delivery.instructions.trim() || missingOutput)) {
        const tool = selectTool(requirement.tags ?? [], lane.executorTool)
        if (!tool || !lane.runId) throw new Error('Configured delivery requires an available agent and worker run')
        const prompt = `Perform only the delivery stage. Acceptance and integration are later stages; their outputs are not delivery prerequisites. Local availability reporting is performed by the daemon; inspect file bytes directly instead of calling tw req output verify.\nComplete Task Weaver delivery for requirement ${requirement.id}: ${requirement.title}.\nDescription: ${requirement.description ?? ''}\nDelivery method: ${workflow.delivery.method}\nInstructions: ${workflow.delivery.instructions || 'Register the required delivery evidence.'}\nExisting outputs: ${JSON.stringify(outputs)}\nReuse valid existing evidence instead of registering duplicate output records. Multiple records referencing the same valid output do not by themselves require rework. Use tw req output register ${requirement.id} to register missing outputs. For comments, use a completed task as the comment target. Local files must be registered with --type local --file. The daemon owns Git commit, push and optional PR creation. Do not claim or release the requirement.\n${extraWorkerPrompt ?? ''}\n${WORKFLOW_RESULT_PROTOCOL}`
        result = await runWorkflowAgent({ config: cliConfig, daemonId, requirement, runId: lane.runId, leaseGeneration: lane.leaseGeneration,
          workerIndex: w.index, stage: 'delivery', tool, argv: buildArgv(tool, prompt, workspace.rootPath), cwd: workspace.rootPath, signal })
      }
      if (result.decision === 'complete' && gitDelivery) {
        const deliveries = await finalizeCompositeWorkspace({ assertAuthority: async () => { await daemonPost(`/api/v1/daemons/${daemonId}/execution-authority`, { requirementId: requirement.id, ...fence }) }, config: cliConfig, workspace, entries: lane.repositories, requirement, updateDelivery: patchDelivery, createPullRequest: workflow.delivery.method === 'git_pr', signal })
        if (deliveries.some((delivery) => delivery.result.deliveryStatus === 'failed')) throw new Error('Git delivery remains incomplete')
        for (const delivery of deliveries) await daemonPost(`/api/v1/requirements/${requirement.id}/workflow-outputs`, {
          type: workflow.delivery.method, requirementRepositoryId: delivery.linkId,
          url: delivery.result.pullRequestUrl, summary: `${delivery.result.deliveryStatus}: ${delivery.result.headCommit ?? 'no commit'}`, ...fence,
        })
      }
      active()
      const latest = await daemonGet<any>(`/api/v1/requirements/${requirement.id}`)
      await daemonPost(`/api/v1/requirements/${requirement.id}/workflow-advance`, { stage: 'delivery', ...result, expectedRevision: latest.workflowStateRevision, ...fence })
      succeeded = result.decision === 'complete'
    } finally {
      await daemonPost(`/api/v1/requirements/${requirement.id}/release`, { reason: 'Delivery worker finished', ...fence }).catch(() => undefined)
      leaseSupervisor.unregister(String(w.index))
      w.activeProcess = false
      w.currentRequirementId = null
      w.requirementTitle = null
      w.startedAt = null
      w.worktreePath = null
      w.runId = null
      w.leaseGeneration = null
      await reportDaemonStatus(workers.some((worker) => worker.activeProcess) ? 'busy' : 'idle')
    }
    if (once) await stopDaemon('idle', succeeded ? 0 : 1)
    else { resetBackoff(w); schedulePoll(w) }
  }
}
