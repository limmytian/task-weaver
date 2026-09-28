import { accessSync, constants as fsConstants, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runCommand, type AsyncCommandResult } from './async-command.js'
import { loadConfig, type Config } from './config.js'
import {
  PIPELINE_MODEL_TIERS,
  type DaemonPipelineConfig,
  type PipelineRole,
} from './daemon-pipeline-config.js'
import {
  resolveRepositoryCredential,
  type CredentialRepository,
  type RepositoryOperation,
} from './repository-credentials.js'

export type PipelinePreflightStatus = 'pass' | 'warn' | 'fail'

export interface PipelinePreflightCheck {
  name: string
  status: PipelinePreflightStatus
  detail: string
  role?: PipelineRole
  repository?: string
  failureCode?: string
}

export interface PipelinePreflightResult {
  ready: boolean
  checkedAt: string
  checks: PipelinePreflightCheck[]
}

interface RequirementRepositoryLink {
  baseBranch?: string | null
  repositoryId?: string
  repository?: CredentialRepository & {
    canonicalKey?: string
    defaultBranch?: string | null
    sshCloneUrl?: string | null
    httpsCloneUrl?: string | null
  }
}

interface RequirementWithRepositories {
  status?: string
  repositories?: RequirementRepositoryLink[]
}

type ToolRunner = (
  command: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
) => Promise<Pick<AsyncCommandResult, 'ok' | 'status' | 'timedOut' | 'errorCode' | 'stderr'>>

export interface PipelinePreflightDependencies {
  apiGet?: <T>(path: string) => Promise<T>
  runTool?: ToolRunner
  cliConfig?: Config
  worktreeRoot?: string
  environment?: NodeJS.ProcessEnv
}

const KNOWN_AI_TOOLS = ['codex', 'claude', 'agy', 'aider', 'cursor']
const TERMINAL_REQUIREMENT_STATUSES = new Set(['done', 'cancelled', 'archived'])

function detectTools(environment: NodeJS.ProcessEnv) {
  const separator = process.platform === 'win32' ? ';' : ':'
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  const paths = (environment.PATH ?? '').split(separator).filter(Boolean)
  return KNOWN_AI_TOOLS.filter((tool) => paths.some((directory) => {
    try {
      accessSync(join(directory, `${tool}${suffix}`), fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }))
}

function pushCheck(checks: PipelinePreflightCheck[], check: PipelinePreflightCheck) {
  checks.push(check)
}

function normalizeRequirements(value: unknown): RequirementWithRepositories[] {
  if (Array.isArray(value)) return value as RequirementWithRepositories[]
  if (value && typeof value === 'object' && 'items' in value) {
    const items = (value as { items?: unknown }).items
    return Array.isArray(items) ? items as RequirementWithRepositories[] : []
  }
  return []
}

function uniqueRepositories(requirements: RequirementWithRepositories[]) {
  const repositories = new Map<string, RequirementRepositoryLink>()
  for (const requirement of requirements) {
    if (requirement.status && TERMINAL_REQUIREMENT_STATUSES.has(requirement.status)) continue
    for (const link of requirement.repositories ?? []) {
      if (!link.repository) continue
      const key = `${link.repository.id}:${link.baseBranch ?? link.repository.defaultBranch ?? 'main'}`
      repositories.set(key, link)
    }
  }
  return [...repositories.values()]
}

function repositoryLabel(link: RequirementRepositoryLink) {
  return link.repository?.canonicalKey ?? link.repository?.id ?? link.repositoryId ?? 'unknown-repository'
}

export async function runPipelinePreflight(
  config: DaemonPipelineConfig,
  dependencies: PipelinePreflightDependencies = {},
): Promise<PipelinePreflightResult> {
  const checks: PipelinePreflightCheck[] = []
  const runTool = dependencies.runTool ?? ((command, args, commandEnvironment) => runCommand(command, args, {
    timeoutMs: 30_000,
    killGraceMs: 1_000,
    maxOutputBytes: 128 * 1024,
    env: commandEnvironment,
  }))
  const environment = dependencies.environment ?? process.env
  const loadedConfig = dependencies.cliConfig ?? loadConfig()
  const cliConfig: Config = {
    ...loadedConfig,
    apiUrl: environment.TW_API_URL ?? loadedConfig.apiUrl,
    apiKey: environment.TW_API_KEY ?? loadedConfig.apiKey,
  }
  const apiGet = dependencies.apiGet ?? (async <T>(path: string) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Actor-Type': 'agent',
      'X-Actor-Id': environment.TW_ACTOR_ID ?? cliConfig.actorId ?? cliConfig.clientId ?? 'tw-cli',
    }
    if (cliConfig.apiKey) headers.Authorization = `Bearer ${cliConfig.apiKey}`
    const response = await fetch(`${cliConfig.apiUrl}${path}`, { headers })
    if (!response.ok) throw new Error(`API request failed: HTTP ${response.status} for ${path}`)
    return response.json() as Promise<T>
  })

  let requirements: RequirementWithRepositories[] = []
  try {
    await apiGet('/api/v1/daemons')
    const response = await apiGet<unknown>(`/api/v1/projects/${config.projectId}/requirements`)
    requirements = normalizeRequirements(response)
    pushCheck(checks, {
      name: 'api-and-role-registration',
      status: 'pass',
      detail: `API is reachable and exposes daemon role registration for project ${config.projectId}.`,
    })
  } catch (error) {
    pushCheck(checks, {
      name: 'api-and-role-registration',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      failureCode: 'api_unavailable',
    })
  }

  const detectedTools = detectTools(environment)
  const roleTools: Array<{ role: PipelineRole; required: boolean; tools: string[] }> = [
    {
      role: 'executor',
      required: config.roles.executor.enabled,
      tools: config.roles.executor.tools.length > 0 ? config.roles.executor.tools : detectedTools,
    },
    {
      role: 'reviewer',
      required: config.roles.reviewer.enabled && !config.roles.reviewer.skipAiReview,
      tools: config.roles.reviewer.tools.length > 0 ? config.roles.reviewer.tools : detectedTools,
    },
  ]
  for (const entry of roleTools.filter((candidate) => candidate.required)) {
    const results = await Promise.all(entry.tools.map(async (tool) => ({ tool, result: await runTool(tool, ['--version']) })))
    const runnable = results.filter(({ result }) => result.ok || (result.status !== null && !result.timedOut && !result.errorCode))
    pushCheck(checks, runnable.length > 0 ? {
      name: 'ai-tool',
      role: entry.role,
      status: 'pass',
      detail: `Runnable AI tools: ${runnable.map(({ tool }) => tool).join(', ')}.`,
    } : {
      name: 'ai-tool',
      role: entry.role,
      status: 'fail',
      detail: entry.tools.length === 0
        ? 'No AI tool is configured or detected.'
        : `Configured AI tools are not runnable: ${entry.tools.join(', ')}.`,
      failureCode: 'ai_tool_unavailable',
    })
  }

  for (const role of ['executor', 'reviewer'] as const) {
    const mappings = config.roles[role].models
    const efforts = config.roles[role].reasoningEffort
    const configuredTiers = PIPELINE_MODEL_TIERS.filter((tier) => mappings[tier] || efforts[tier])
    pushCheck(checks, {
      name: 'model-mapping',
      role,
      status: 'pass',
      detail: configuredTiers.length > 0
        ? `Model and reasoning settings are valid for: ${configuredTiers.join(', ')}.`
        : 'Server model defaults will be used.',
    })
  }

  const promptFiles = [
    ...config.roles.executor.promptFiles.map((path) => ({ role: 'executor' as const, path })),
    ...config.roles.reviewer.promptFiles.map((path) => ({ role: 'reviewer' as const, path })),
  ]
  for (const prompt of promptFiles) {
    pushCheck(checks, existsSync(prompt.path) ? {
      name: 'prompt-file', role: prompt.role, status: 'pass', detail: `${prompt.path} is readable.`,
    } : {
      name: 'prompt-file', role: prompt.role, status: 'fail', detail: `${prompt.path} does not exist.`, failureCode: 'prompt_file_missing',
    })
  }

  for (const check of config.roles.reviewer.checks) {
    const result = await runTool('/bin/sh', ['-n', '-c', check])
    pushCheck(checks, result.ok ? {
      name: 'review-check', role: 'reviewer', status: 'pass', detail: `Shell syntax is valid: ${check}`,
    } : {
      name: 'review-check', role: 'reviewer', status: 'fail', detail: `Invalid shell check: ${check}`, failureCode: 'review_check_invalid',
    })
  }

  const worktreeRoot = dependencies.worktreeRoot ?? join(homedir(), '.task-weaver', 'requirement-workspaces')
  try {
    mkdirSync(worktreeRoot, { recursive: true })
    accessSync(worktreeRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
    pushCheck(checks, { name: 'worktree-root', status: 'pass', detail: `${worktreeRoot} is writable.` })
  } catch (error) {
    pushCheck(checks, {
      name: 'worktree-root',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      failureCode: 'worktree_root_unavailable',
    })
  }

  for (const link of uniqueRepositories(requirements)) {
    const repository = link.repository!
    const label = repositoryLabel(link)
    const baseBranch = link.baseBranch ?? repository.defaultBranch ?? config.baseBranch
    const requiredOperations: RepositoryOperation[] = ['read', 'push']
    for (const operation of requiredOperations) {
      const readiness = resolveRepositoryCredential(cliConfig, repository, operation, undefined, environment)
      pushCheck(checks, readiness.state === 'available' ? {
        name: `repository-${operation}`,
        repository: label,
        status: 'pass',
        detail: `${operation} credentials are ready via ${readiness.transport}.`,
      } : {
        name: `repository-${operation}`,
        repository: label,
        status: 'fail',
        detail: `${operation} credentials are ${readiness.state}: ${readiness.reasonCode}.`,
        failureCode: `repository_${operation}_${readiness.reasonCode}`,
      })
    }

    const forgeReadiness = resolveRepositoryCredential(cliConfig, repository, 'forge', undefined, environment)
    const forgeRequired = config.mergePolicy.mode === 'provider'
    pushCheck(checks, forgeReadiness.state === 'available' ? {
      name: 'repository-forge', repository: label, status: 'pass', detail: 'Forge credentials are ready.',
    } : {
      name: 'repository-forge',
      repository: label,
      status: forgeRequired ? 'fail' : 'warn',
      detail: `Forge credentials are ${forgeReadiness.state}: ${forgeReadiness.reasonCode}.`,
      ...(forgeRequired ? { failureCode: `repository_forge_${forgeReadiness.reasonCode}` } : {}),
    })

    const readReadiness = resolveRepositoryCredential(cliConfig, repository, 'read', undefined, environment)
    const cloneUrl = readReadiness.transport === 'ssh' ? repository.sshCloneUrl : repository.httpsCloneUrl
    if (readReadiness.state === 'available' && cloneUrl) {
      const branchResult = await runTool('/usr/bin/git', [
        ...(readReadiness.trustedGitConfig ?? []),
        'ls-remote', '--exit-code', cloneUrl, `refs/heads/${baseBranch}`,
      ], readReadiness.trustedEnvironment)
      pushCheck(checks, branchResult.ok ? {
        name: 'base-branch', repository: label, status: 'pass', detail: `Base branch ${baseBranch} is reachable.`,
      } : {
        name: 'base-branch', repository: label, status: 'fail', detail: `Base branch ${baseBranch} is not reachable.`, failureCode: 'base_branch_unreachable',
      })
    }
  }

  return {
    ready: checks.every((check) => check.status !== 'fail'),
    checkedAt: new Date().toISOString(),
    checks,
  }
}
