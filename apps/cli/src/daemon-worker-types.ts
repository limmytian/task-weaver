import type { RequirementRepositoryEntry } from './repository-workspace.js'

export interface WorkerState {
  index: number
  currentRequirementId: string | null
  currentExecutionSliceId: string | null
  currentTaskId: string | null
  requirementTitle: string | null
  executionSliceTitle: string | null
  taskTitle: string | null
  modelTier: string | null
  model: string | null
  reasoningEffort: string | null
  runId: string | null
  leaseGeneration: number | null
  leaseHealthy: boolean | null
  leaseHeartbeatFailures: number
  lastLeaseError: string | null
  branchName: string | null
  worktreePath: string | null
  startedAt: string | null
  activeProcess: boolean
  pollTimer: ReturnType<typeof setTimeout> | null
  currentInterval: number
  polling: boolean
  lastEligibilitySummary: string | null
}

export interface RequirementLane {
  stage?: 'execution' | 'delivery'
  requirement: any
  executionSlice?: any | null
  task: any
  tasks: any[]
  repositories: RequirementRepositoryEntry[]
  executorTool?: string | null
  leaseGeneration: number
  runId?: string
}

