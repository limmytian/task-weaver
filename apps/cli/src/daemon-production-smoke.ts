import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type RealSmokeProvider = 'github' | 'gitea'

type OwnerType = 'user' | 'organization'

export interface RealSmokeProviderConfig {
  provider: RealSmokeProvider
  host: string
  owner: string
  ownerType: OwnerType
  credentialProfileRef: string
  apiBaseUrl: string
  primaryToken: string
  reviewerToken: string
}

export interface RealSmokeConfig {
  apiUrl: string
  apiKey: string
  actorId: string
  aiTool: string
  providers: RealSmokeProviderConfig[]
  timeoutMs: number
  pollIntervalMs: number
  requirementCount: number
  keepOnFailure: boolean
  runId: string
  commitSha: string
}

export interface RemoteSmokeRepository {
  provider: RealSmokeProvider
  host: string
  owner: string
  name: string
  webUrl: string
  httpsCloneUrl: string
  credentialProfileRef: string
}

export interface SmokeRequirement {
  id: string
  status: string
  title: string
}

export interface SmokeRepositoryDelivery {
  link: {
    id: string
    deliveryStatus: string
    pullRequestExternalId?: string | null
    pullRequestUrl?: string | null
    pushedCommit?: string | null
    failureCode?: string | null
  }
  repository: {
    id: string
    provider: string
    canonicalKey: string
  }
}

export interface SmokeControlPlane {
  createProject(name: string, description: string): Promise<{ id: string }>
  createCatalogRepository(repository: RemoteSmokeRepository): Promise<{ id: string }>
  createRequirement(projectId: string, input: Record<string, unknown>): Promise<SmokeRequirement>
  createTask(projectId: string, input: Record<string, unknown>): Promise<{ id: string }>
  linkRepository(requirementId: string, input: Record<string, unknown>): Promise<void>
  setReviewPolicy(requirementId: string): Promise<void>
  approveRequirement(requirementId: string): Promise<void>
  getRequirement(requirementId: string): Promise<SmokeRequirement>
  listDeliveries(requirementId: string): Promise<SmokeRepositoryDelivery[]>
  cancelRequirement(requirementId: string): Promise<void>
  archiveProject(projectId: string): Promise<void>
  archiveCatalogRepository(repositoryId: string): Promise<void>
}

export interface SmokeForge {
  createRepository(config: RealSmokeProviderConfig, name: string): Promise<RemoteSmokeRepository>
  protectMain(config: RealSmokeProviderConfig, repository: RemoteSmokeRepository): Promise<void>
  approvePullRequest(
    config: RealSmokeProviderConfig,
    repository: RemoteSmokeRepository,
    externalId: string,
  ): Promise<void>
  deleteRepository(config: RealSmokeProviderConfig, repository: RemoteSmokeRepository): Promise<void>
}

export interface SmokePipelineHandle {
  exited: Promise<{ code: number | null; output: string }>
  stop(): Promise<void>
}

export interface SmokePipeline {
  start(projectId: string, aiTool: string): Promise<SmokePipelineHandle>
}

export interface RealSmokeDependencies {
  controlPlane: SmokeControlPlane
  forge: SmokeForge
  pipeline: SmokePipeline
  sleep(ms: number): Promise<void>
  log(message: string): void
}

export interface RealSmokeReport {
  runId: string
  commitSha: string
  completedAt: string
  projectId: string
  providers: RealSmokeProvider[]
  requirementIds: string[]
  repositoryKeys: string[]
  approvals: number
  deliveries: number
  durationMs: number
  cleanedUp: boolean
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Real daemon smoke requires ${name}`)
  return value
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  }
  return value
}

function ownerType(env: NodeJS.ProcessEnv, name: string): OwnerType {
  const value = env[name]?.trim() || 'organization'
  if (value !== 'user' && value !== 'organization') {
    throw new Error(`${name} must be user or organization`)
  }
  return value
}

function parseProviders(value: string | undefined): RealSmokeProvider[] {
  const providers = [...new Set((value || 'github,gitea').split(',').map((item) => item.trim()).filter(Boolean))]
  if (providers.length === 0 || providers.some((provider) => provider !== 'github' && provider !== 'gitea')) {
    throw new Error('TW_REAL_SMOKE_PROVIDERS must contain github and/or gitea')
  }
  return providers as RealSmokeProvider[]
}

export function parseRealSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { providers?: string; aiTool?: string; timeoutSeconds?: number; keepOnFailure?: boolean } = {},
): RealSmokeConfig {
  if (env.TW_REAL_SMOKE !== '1') {
    throw new Error('Real daemon smoke is destructive and opt-in; set TW_REAL_SMOKE=1')
  }
  const selectedProviders = parseProviders(overrides.providers ?? env.TW_REAL_SMOKE_PROVIDERS)
  const providers = selectedProviders.map((provider): RealSmokeProviderConfig => {
    if (provider === 'github') {
      const primaryToken = required(env, 'GH_TOKEN')
      const reviewerToken = required(env, 'TW_SMOKE_GITHUB_REVIEW_TOKEN')
      if (primaryToken === reviewerToken) throw new Error('GitHub smoke reviewer token must belong to a different actor')
      return {
        provider,
        host: 'github.com',
        owner: required(env, 'TW_SMOKE_GITHUB_OWNER'),
        ownerType: ownerType(env, 'TW_SMOKE_GITHUB_OWNER_TYPE'),
        credentialProfileRef: required(env, 'TW_SMOKE_GITHUB_CREDENTIAL_PROFILE'),
        apiBaseUrl: 'https://api.github.com',
        primaryToken,
        reviewerToken,
      }
    }
    const primaryToken = required(env, 'GITEA_TOKEN')
    const reviewerToken = required(env, 'TW_SMOKE_GITEA_REVIEW_TOKEN')
    if (primaryToken === reviewerToken) throw new Error('Gitea smoke reviewer token must belong to a different actor')
    const host = required(env, 'TW_SMOKE_GITEA_HOST').replace(/^https?:\/\//, '').replace(/\/$/, '')
    return {
      provider,
      host,
      owner: required(env, 'TW_SMOKE_GITEA_OWNER'),
      ownerType: ownerType(env, 'TW_SMOKE_GITEA_OWNER_TYPE'),
      credentialProfileRef: required(env, 'TW_SMOKE_GITEA_CREDENTIAL_PROFILE'),
      apiBaseUrl: `https://${host}/api/v1`,
      primaryToken,
      reviewerToken,
    }
  })
  const timeoutSeconds = overrides.timeoutSeconds
    ?? positiveInteger(env, 'TW_REAL_SMOKE_TIMEOUT_SECONDS', 1_800, 7_200)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 7_200) {
    throw new Error('Real daemon smoke timeout must be from 60 to 7200 seconds')
  }
  return {
    apiUrl: required(env, 'TW_API_URL').replace(/\/$/, ''),
    apiKey: required(env, 'TW_API_KEY'),
    actorId: env.TW_ACTOR_ID?.trim() || 'daemon-production-smoke',
    aiTool: overrides.aiTool?.trim() || env.TW_REAL_SMOKE_AI_TOOL?.trim() || 'codex',
    providers,
    timeoutMs: timeoutSeconds * 1_000,
    pollIntervalMs: positiveInteger(env, 'TW_REAL_SMOKE_POLL_SECONDS', 5, 60) * 1_000,
    requirementCount: positiveInteger(env, 'TW_REAL_SMOKE_REQUIREMENTS', 2, 5),
    keepOnFailure: overrides.keepOnFailure ?? env.TW_REAL_SMOKE_KEEP_ON_FAILURE === '1',
    runId: `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    commitSha: env.GITHUB_SHA?.trim()
      || env.GITEA_COMMIT_SHA?.trim()
      || env.CI_COMMIT_SHA?.trim()
      || env.TW_RELEASE_COMMIT_SHA?.trim()
      || 'local-unbound',
  }
}

function safeName(runId: string, suffix: string): string {
  return `tw-daemon-smoke-${runId}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90)
}

export async function runDaemonProductionSmoke(
  config: RealSmokeConfig,
  dependencies: RealSmokeDependencies,
): Promise<RealSmokeReport> {
  const startedAt = Date.now()
  const remoteRepositories: Array<{ config: RealSmokeProviderConfig; repository: RemoteSmokeRepository }> = []
  const catalogRepositoryIds: string[] = []
  const requirementIds: string[] = []
  const approvedPullRequests = new Set<string>()
  let projectId = ''
  let pipeline: SmokePipelineHandle | null = null
  let succeeded = false
  let cleanupFailure: Error | null = null

  const cleanup = async () => {
    const failures: string[] = []
    await pipeline?.stop().catch((error) => {
      failures.push(`pipeline: ${error instanceof Error ? error.message : String(error)}`)
    })
    pipeline = null
    if (!succeeded) {
      for (const requirementId of [...requirementIds].reverse()) {
        await dependencies.controlPlane.cancelRequirement(requirementId).catch((error) => {
          failures.push(`requirement ${requirementId}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
    if (projectId) {
      await dependencies.controlPlane.archiveProject(projectId).catch((error) => {
        failures.push(`project ${projectId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    for (const repositoryId of [...catalogRepositoryIds].reverse()) {
      await dependencies.controlPlane.archiveCatalogRepository(repositoryId).catch((error) => {
        failures.push(`catalog ${repositoryId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    for (const entry of [...remoteRepositories].reverse()) {
      await dependencies.forge.deleteRepository(entry.config, entry.repository).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error))
      })
    }
    if (failures.length > 0) throw new Error(`Smoke cleanup failed: ${failures.join('; ')}`)
  }

  try {
    dependencies.log(`Creating disposable smoke resources for ${config.runId}.`)
    projectId = (await dependencies.controlPlane.createProject(
      `Daemon production smoke ${config.runId}`,
      'Disposable project created by the scheduled daemon production smoke gate.',
    )).id

    for (const providerConfig of config.providers) {
      const repository = await dependencies.forge.createRepository(
        providerConfig,
        safeName(config.runId, providerConfig.provider),
      )
      remoteRepositories.push({ config: providerConfig, repository })
      await dependencies.forge.protectMain(providerConfig, repository)
      const catalog = await dependencies.controlPlane.createCatalogRepository(repository)
      catalogRepositoryIds.push(catalog.id)
    }

    for (let index = 0; index < config.requirementCount; index += 1) {
      const branchName = `smoke/${config.runId}/${index + 1}`
      const requirementDescription = [
        `This is disposable production-smoke run ${config.runId}.`,
        `In every linked repository create smoke/${config.runId}-${index + 1}.md containing the run ID and repository identity.`,
        'Commit the changes, mark the task done, and do not modify CI, credentials, or unrelated files.',
      ].join(' ')
      const requirement = await dependencies.controlPlane.createRequirement(projectId, {
        title: `Real daemon pipeline smoke ${index + 1}`,
        description: requirementDescription,
        status: 'draft',
        priority: 'critical',
        modelTier: 'strong',
        tags: ['daemon', 'production-smoke', `run:${config.runId}`],
        branchName,
      })
      requirementIds.push(requirement.id)
      for (let repositoryIndex = 0; repositoryIndex < catalogRepositoryIds.length; repositoryIndex += 1) {
        await dependencies.controlPlane.linkRepository(requirement.id, {
          repositoryId: catalogRepositoryIds[repositoryIndex],
          baseBranch: 'main',
          workingBranch: branchName,
        })
      }
      await dependencies.controlPlane.createTask(projectId, {
        requirementId: requirement.id,
        title: `Write multi-repository smoke marker ${index + 1}`,
        description: requirementDescription,
        status: 'todo',
        priority: 'urgent',
        tags: ['daemon', 'production-smoke', `run:${config.runId}`],
      })
      await dependencies.controlPlane.setReviewPolicy(requirement.id)
      await dependencies.controlPlane.approveRequirement(requirement.id)
    }

    pipeline = await dependencies.pipeline.start(projectId, config.aiTool)
    const pipelineState: { exit: { code: number | null; output: string } | null } = { exit: null }
    void pipeline.exited.then((result) => { pipelineState.exit = result })
    const deadline = startedAt + config.timeoutMs
    let deliveries: SmokeRepositoryDelivery[] = []

    while (Date.now() < deadline) {
      if (pipelineState.exit && requirementIds.length > 0) {
        throw new Error(`Daemon smoke pipeline exited early (${pipelineState.exit.code}): ${pipelineState.exit.output}`)
      }
      const requirements = await Promise.all(
        requirementIds.map((requirementId) => dependencies.controlPlane.getRequirement(requirementId)),
      )
      deliveries = (await Promise.all(
        requirementIds.map((requirementId) => dependencies.controlPlane.listDeliveries(requirementId)),
      )).flat()

      for (const delivery of deliveries) {
        const externalId = delivery.link.pullRequestExternalId
        if (!externalId || !['in_review', 'ready_to_merge', 'failed'].includes(delivery.link.deliveryStatus)) continue
        const remote = remoteRepositories.find((entry) =>
          entry.repository.provider === delivery.repository.provider
          && `${entry.repository.host}/${entry.repository.owner}/${entry.repository.name}`.toLowerCase()
            === delivery.repository.canonicalKey.toLowerCase(),
        )
        if (!remote) throw new Error(`No disposable remote matches ${delivery.repository.canonicalKey}`)
        const approvalKey = `${delivery.link.id}:${externalId}:${delivery.link.pushedCommit ?? 'head'}`
        if (approvedPullRequests.has(approvalKey)) continue
        await dependencies.forge.approvePullRequest(remote.config, remote.repository, externalId)
        approvedPullRequests.add(approvalKey)
        dependencies.log(`Approved ${delivery.repository.provider} pull request ${externalId}.`)
      }

      const terminal = requirements.every((requirement) => requirement.status === 'done')
      if (terminal) {
        const incomplete = deliveries.filter((delivery) => delivery.link.deliveryStatus !== 'merged')
        if (incomplete.length > 0) {
          throw new Error(`Requirements completed with ${incomplete.length} non-merged repository deliveries`)
        }
        succeeded = true
        await pipeline.stop()
        pipeline = null
        await cleanup()
        return {
          runId: config.runId,
          commitSha: config.commitSha,
          completedAt: new Date().toISOString(),
          projectId,
          providers: config.providers.map((provider) => provider.provider),
          requirementIds,
          repositoryKeys: remoteRepositories.map((entry) =>
            `${entry.repository.host}/${entry.repository.owner}/${entry.repository.name}`,
          ),
          approvals: approvedPullRequests.size,
          deliveries: deliveries.length,
          durationMs: Date.now() - startedAt,
          cleanedUp: true,
        }
      }
      const cancelled = requirements.find((requirement) => requirement.status === 'cancelled')
      if (cancelled) throw new Error(`Smoke requirement ${cancelled.id} was cancelled`)
      await dependencies.sleep(config.pollIntervalMs)
    }
    throw new Error(`Daemon production smoke timed out after ${config.timeoutMs / 1_000} seconds`)
  } finally {
    if (!succeeded && !config.keepOnFailure) {
      await cleanup().catch((error) => {
        cleanupFailure = error instanceof Error ? error : new Error(String(error))
      })
    }
    if (cleanupFailure) throw cleanupFailure
  }
}

class ApiControlPlane implements SmokeControlPlane {
  constructor(private readonly config: RealSmokeConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000)
      throw new Error(`Task Weaver ${method} ${path} failed with HTTP ${response.status}: ${detail}`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  createProject(name: string, description: string) {
    return this.request<{ id: string }>('POST', '/projects', { name, description })
  }

  createCatalogRepository(repository: RemoteSmokeRepository) {
    return this.request<{ id: string }>('POST', '/repositories', {
      displayName: `Disposable ${repository.provider} daemon smoke`,
      provider: repository.provider,
      host: repository.host,
      namespace: repository.owner,
      name: repository.name,
      webUrl: repository.webUrl,
      httpsCloneUrl: repository.httpsCloneUrl,
      defaultBranch: 'main',
      tags: ['daemon', 'production-smoke', `run:${this.config.runId}`],
      visibility: 'instance',
      authPolicy: {
        allowedTransports: ['https'],
        preferredTransport: 'https',
        allowedOperations: ['read', 'push', 'forge'],
        credentialProfileRef: repository.credentialProfileRef,
        revision: 1,
      },
    })
  }

  createRequirement(projectId: string, input: Record<string, unknown>) {
    return this.request<SmokeRequirement>('POST', `/projects/${projectId}/requirements`, input)
  }

  createTask(projectId: string, input: Record<string, unknown>) {
    return this.request<{ id: string }>('POST', `/projects/${projectId}/tasks`, input)
  }

  async linkRepository(requirementId: string, input: Record<string, unknown>) {
    await this.request('POST', `/requirements/${requirementId}/repositories`, input)
  }

  async setReviewPolicy(requirementId: string) {
    await this.request('PUT', `/requirements/${requirementId}/review-policy`, {
      requiredChecks: [],
      requireAiReview: true,
      minimumHumanApprovals: 1,
      requireIndependentReviewer: true,
      requireIndependentMerger: true,
      allowedMergeModes: ['provider'],
      defaultMergeMode: 'provider',
      baseBranch: 'main',
      retryPolicy: { maxAttempts: 8, initialBackoffSeconds: 5, maxBackoffSeconds: 60 },
      allowManualOverride: false,
      overrideRequiresReason: true,
    })
  }

  async approveRequirement(requirementId: string) {
    await this.request('PATCH', `/requirements/${requirementId}`, { status: 'approved' })
  }

  getRequirement(requirementId: string) {
    return this.request<SmokeRequirement>('GET', `/requirements/${requirementId}`)
  }

  async listDeliveries(requirementId: string) {
    const value = await this.request<SmokeRepositoryDelivery[] | { items: SmokeRepositoryDelivery[] }>(
      'GET', `/requirements/${requirementId}/repositories`,
    )
    return Array.isArray(value) ? value : value.items
  }

  async cancelRequirement(requirementId: string) {
    await this.request('DELETE', `/requirements/${requirementId}`)
  }

  async archiveProject(projectId: string) {
    await this.request('DELETE', `/projects/${projectId}`)
  }

  async archiveCatalogRepository(repositoryId: string) {
    await this.request('DELETE', `/repositories/${repositoryId}`)
  }
}

async function providerRequest<T>(
  config: RealSmokeProviderConfig,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: config.provider === 'github' ? `Bearer ${token}` : `token ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(config.provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000)
    throw new Error(`${config.provider} ${method} ${path} failed with HTTP ${response.status}: ${detail}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

class ApiSmokeForge implements SmokeForge {
  async createRepository(config: RealSmokeProviderConfig, name: string): Promise<RemoteSmokeRepository> {
    const path = config.ownerType === 'organization' ? `/orgs/${config.owner}/repos` : '/user/repos'
    const response = await providerRequest<Record<string, any>>(config, config.primaryToken, 'POST', path, {
      name,
      private: true,
      auto_init: true,
      default_branch: 'main',
      description: 'Disposable Task Weaver daemon production smoke repository.',
    })
    const owner = String(response.owner?.login ?? response.owner?.username ?? config.owner)
    if (owner.toLowerCase() !== config.owner.toLowerCase()) {
      throw new Error(`${config.provider} created ${name} under unexpected owner ${owner}`)
    }
    return {
      provider: config.provider,
      host: config.host,
      owner,
      name,
      webUrl: String(response.html_url ?? response.website ?? `https://${config.host}/${owner}/${name}`),
      httpsCloneUrl: String(response.clone_url ?? `https://${config.host}/${owner}/${name}.git`),
      credentialProfileRef: config.credentialProfileRef,
    }
  }

  async protectMain(config: RealSmokeProviderConfig, repository: RemoteSmokeRepository) {
    const path = `/repos/${repository.owner}/${repository.name}/branches/main/protection`
    if (config.provider === 'github') {
      await providerRequest(config, config.primaryToken, 'PUT', path, {
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          required_approving_review_count: 1,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      })
      return
    }
    await providerRequest(
      config,
      config.primaryToken,
      'POST',
      `/repos/${repository.owner}/${repository.name}/branch_protections`,
      {
        rule_name: 'main',
        branch_name: 'main',
        enable_push: false,
        enable_push_whitelist: false,
        enable_merge_whitelist: false,
        required_approvals: 1,
        block_on_rejected_reviews: true,
        dismiss_stale_approvals: true,
      },
    )
  }

  async approvePullRequest(
    config: RealSmokeProviderConfig,
    repository: RemoteSmokeRepository,
    externalId: string,
  ) {
    const path = `/repos/${repository.owner}/${repository.name}/pulls/${externalId}/reviews`
    await providerRequest(config, config.reviewerToken, 'POST', path, config.provider === 'github'
      ? { event: 'APPROVE', body: 'Approved by the independent Task Weaver production smoke actor.' }
      : { event: 'APPROVED', body: 'Approved by the independent Task Weaver production smoke actor.' })
  }

  async deleteRepository(config: RealSmokeProviderConfig, repository: RemoteSmokeRepository) {
    await providerRequest(config, config.primaryToken, 'DELETE', `/repos/${repository.owner}/${repository.name}`)
  }
}

function boundedAppend(current: string, chunk: string): string {
  const combined = `${current}${chunk}`
  return combined.length > 32_000 ? combined.slice(-32_000) : combined
}

class ProcessSmokePipeline implements SmokePipeline {
  async start(projectId: string, aiTool: string): Promise<SmokePipelineHandle> {
    const root = await mkdtemp(join(tmpdir(), 'tw-daemon-real-smoke-'))
    const configPath = join(root, 'pipeline.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projectId,
      baseBranch: 'main',
      runMode: 'service',
      roles: {
        executor: { workers: 1, tools: [aiTool], capabilities: ['production-smoke'] },
        reviewer: { workers: 1, tools: [aiTool], checks: [], postForgeSummary: false },
        merger: { workers: 1 },
      },
      retry: { maxRestarts: 3, initialBackoffMs: 1_000, maxBackoffMs: 30_000 },
      limits: { maxActiveRoles: 3, shutdownGraceMs: 30_000, controlPollMs: 500 },
      mergePolicy: { mode: 'provider' },
      logging: { directory: join(root, 'runs'), maxBytes: 8_388_608, maxFiles: 3 },
    }, null, 2), { mode: 0o600 })

    const entrypoint = process.argv[1]
    if (!entrypoint) throw new Error('Cannot locate the current tw CLI entrypoint')
    const child = spawn(process.execPath, [
      ...process.execArgv,
      entrypoint,
      'daemon', 'pipeline', 'start', '--config', configPath, '--service',
    ], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output = boundedAppend(output, chunk) })
    child.stderr?.on('data', (chunk: string) => { output = boundedAppend(output, chunk) })
    const exited = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    })
    return {
      exited,
      stop: () => stopPipelineChild(child, exited, root),
    }
  }
}

async function stopPipelineChild(
  child: ChildProcess,
  exited: Promise<{ code: number | null; output: string }>,
  root: string,
) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 35_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}

export function createRealSmokeDependencies(config: RealSmokeConfig): RealSmokeDependencies {
  return {
    controlPlane: new ApiControlPlane(config),
    forge: new ApiSmokeForge(),
    pipeline: new ProcessSmokePipeline(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(`[Daemon smoke] ${message}`),
  }
}
