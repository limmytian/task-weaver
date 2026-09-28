import { runCommand } from './async-command.js'
import { redactTrustedOutput, type CredentialResolution } from './repository-credentials.js'

export interface GitCommandResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
}

export interface GitProviderCapabilities {
  clone: boolean
  fetch: boolean
  push: boolean
  pullRequest: boolean
  review: boolean
  merge: boolean
}

export interface RepositoryDeliveryResult {
  deliveryStatus: 'pushed' | 'in_review' | 'unchanged' | 'failed'
  headCommit?: string
  pushedCommit?: string
  pushStatus: 'pending' | 'not_needed' | 'pushed' | 'failed'
  pullRequestProvider?: string
  pullRequestExternalId?: string
  pullRequestUrl?: string
  reviewStatus: 'pending' | 'not_supported' | 'in_review' | 'failed'
  mergeStatus: 'pending' | 'not_needed' | 'failed'
  failureCode?: string
  failureSummary?: string
}

export type ForgePullRequestState = 'open' | 'closed' | 'merged'
export type ForgeCheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'
export type ForgeApprovalState = 'approved' | 'changes_requested' | 'commented' | 'dismissed'

export interface ForgeCheck {
  name: string
  state: ForgeCheckState
  url?: string
  summary?: string
}

export interface ForgeApproval {
  actorId: string
  state: ForgeApprovalState
  submittedAt?: string
  headCommit?: string
}

export interface ForgePullRequest {
  provider: string
  externalId: string
  url: string
  state: ForgePullRequestState
  headCommit: string | null
  baseCommit: string | null
  mergeable: boolean | null
  mergeState: string | null
  checks: ForgeCheck[]
  approvals: ForgeApproval[]
  updatedAt?: string
}

export interface ForgeFailure {
  code: string
  summary: string
  category: 'configuration' | 'authentication' | 'infrastructure' | 'policy' | 'not_supported'
  retry: 'automatic' | 'manual'
}

export type ForgeResult<T> = { ok: true; value: T } | { ok: false; failure: ForgeFailure }

export interface ForgePullRequestOptions {
  worktreePath: string
  branchName: string
  baseBranch: string
  title: string
  body: string
  credential: CredentialResolution
  repository?: { host: string; namespace: string; name: string }
}

export interface ForgeReviewOptions extends ForgePullRequestOptions {
  pullRequest: ForgePullRequest
  summary: string
  decision?: 'approve' | 'changes_requested' | 'comment'
}

export interface ForgeMergeOptions extends ForgePullRequestOptions {
  pullRequest: ForgePullRequest
  expectedHeadCommit: string
}

export interface FinalizeRepositoryOptions {
  worktreePath: string
  branchName: string
  baseBranch: string
  title: string
  body: string
  credential: CredentialResolution
  forgeCredential?: CredentialResolution
  skipPush?: boolean
  repository?: { host: string; namespace: string; name: string }
}

export type GitRunner = (
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => GitCommandResult | Promise<GitCommandResult>

export async function runTrustedGitCommand(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  const child = await runCommand(command, args, {
    cwd,
    env: environment,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 120_000,
    signal,
    redact: redactTrustedOutput,
  })
  return {
    ok: child.ok,
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  }
}

function failureSummary(label: string, result: GitCommandResult) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
  return `${label}: ${detail}`.slice(0, 2000)
}

function forgeFailure(label: string, result: GitCommandResult, fallbackCode: string): ForgeFailure {
  const summary = failureSummary(label, result)
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (/not authenticated|authentication|unauthorized|forbidden|bad credentials|login required/.test(detail)) {
    return { code: 'forge_authentication_failed', summary, category: 'authentication', retry: 'manual' }
  }
  if (/protected branch|required check|required review|merge queue|not mergeable|conflict/.test(detail)) {
    return { code: 'forge_policy_blocked', summary, category: 'policy', retry: 'manual' }
  }
  if (/timeout|timed out|connection|network|rate limit|temporar|unavailable|eof/.test(detail)) {
    return { code: 'forge_unavailable', summary, category: 'infrastructure', retry: 'automatic' }
  }
  return { code: fallbackCode, summary, category: 'infrastructure', retry: 'automatic' }
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function normalizeCheckState(value: unknown): ForgeCheckState {
  const state = String(value ?? '').toLowerCase()
  if (['success', 'passed', 'completed'].includes(state)) return 'passed'
  if (['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required'].includes(state)) return 'failed'
  if (['skipped', 'neutral'].includes(state)) return 'skipped'
  if (['in_progress', 'running'].includes(state)) return 'running'
  return 'queued'
}

function normalizeApprovalState(value: unknown): ForgeApprovalState {
  const state = String(value ?? '').toLowerCase()
  if (['approved', 'approve'].includes(state)) return 'approved'
  if (['changes_requested', 'request_changes', 'request-changes'].includes(state)) return 'changes_requested'
  if (state === 'dismissed') return 'dismissed'
  return 'commented'
}

export class GenericGitAdapter {
  readonly provider: string = 'generic'
  readonly capabilities: GitProviderCapabilities = {
    clone: true,
    fetch: true,
    push: true,
    pullRequest: false,
    review: false,
    merge: false,
  }

  constructor(protected readonly run: GitRunner = runTrustedGitCommand) {}

  protected gitArgs(credential: CredentialResolution, args: string[]) {
    return [...(credential.trustedGitConfig ?? []), '--no-pager', ...args]
  }

  async git(credential: CredentialResolution, args: string[], cwd: string): Promise<GitCommandResult> {
    if (credential.state !== 'available' || !credential.trustedEnvironment) {
      return { ok: false, status: null, stdout: '', stderr: `credential readiness: ${credential.reasonCode}` }
    }
    return this.run('git', this.gitArgs(credential, args), cwd, credential.trustedEnvironment)
  }

  protected forgeEnvironment(credential: CredentialResolution): ForgeResult<NodeJS.ProcessEnv> {
    if (credential.state !== 'available' || !credential.trustedEnvironment) {
      return {
        ok: false,
        failure: {
          code: 'forge_credential_unavailable',
          summary: `Forge credentials are unavailable: ${credential.reasonCode}`,
          category: 'configuration',
          retry: 'manual',
        },
      }
    }
    return { ok: true, value: credential.trustedEnvironment }
  }

  async findPullRequest(_options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest | null>> {
    return {
      ok: false,
      failure: {
        code: 'forge_not_supported',
        summary: `Repository provider '${this.provider}' does not support pull requests`,
        category: 'not_supported',
        retry: 'manual',
      },
    }
  }

  async ensurePullRequest(options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest>> {
    const found = await this.findPullRequest(options)
    if (!found.ok) return found
    if (found.value) return { ok: true, value: found.value }
    return {
      ok: false,
      failure: {
        code: 'forge_not_supported',
        summary: `Repository provider '${this.provider}' cannot create pull requests`,
        category: 'not_supported',
        retry: 'manual',
      },
    }
  }

  async postReviewSummary(_options: ForgeReviewOptions): Promise<ForgeResult<ForgePullRequest>> {
    return {
      ok: false,
      failure: {
        code: 'forge_not_supported',
        summary: `Repository provider '${this.provider}' cannot post pull-request reviews`,
        category: 'not_supported',
        retry: 'manual',
      },
    }
  }

  async mergePullRequest(_options: ForgeMergeOptions): Promise<ForgeResult<ForgePullRequest>> {
    return {
      ok: false,
      failure: {
        code: 'forge_not_supported',
        summary: `Repository provider '${this.provider}' cannot merge pull requests`,
        category: 'not_supported',
        retry: 'manual',
      },
    }
  }

  async finalize(options: FinalizeRepositoryOptions): Promise<RepositoryDeliveryResult> {
    const status = await this.git(options.credential, ['status', '--porcelain'], options.worktreePath)
    if (!status.ok) return {
      deliveryStatus: 'failed', pushStatus: 'failed', reviewStatus: 'not_supported', mergeStatus: 'pending',
      failureCode: 'git_status_failed', failureSummary: failureSummary('Git status failed', status),
    }
    if (status.stdout.trim()) {
      const add = await this.git(options.credential, ['add', '-A'], options.worktreePath)
      if (!add.ok) return {
        deliveryStatus: 'failed', pushStatus: 'failed', reviewStatus: 'not_supported', mergeStatus: 'pending',
        failureCode: 'git_stage_failed', failureSummary: failureSummary('Git stage failed', add),
      }
      const commit = await this.git(options.credential, ['commit', '-m', `feat: ${options.title.slice(0, 72)}`], options.worktreePath)
      if (!commit.ok) return {
        deliveryStatus: 'failed', pushStatus: 'failed', reviewStatus: 'not_supported', mergeStatus: 'pending',
        failureCode: 'git_commit_failed', failureSummary: failureSummary('Git commit failed', commit),
      }
    }

    const head = await this.git(options.credential, ['rev-parse', 'HEAD'], options.worktreePath)
    if (!head.ok) return {
      deliveryStatus: 'failed', pushStatus: 'failed', reviewStatus: 'not_supported', mergeStatus: 'pending',
      failureCode: 'git_head_failed', failureSummary: failureSummary('Git head lookup failed', head),
    }
    const base = await this.git(options.credential, ['rev-parse', `origin/${options.baseBranch}`], options.worktreePath)
    if (base.ok && base.stdout.trim() === head.stdout.trim()) {
      return {
        deliveryStatus: 'unchanged', headCommit: head.stdout.trim(), pushStatus: 'not_needed',
        reviewStatus: 'not_supported', mergeStatus: 'not_needed',
      }
    }
    if (!options.skipPush) {
      const push = await this.git(options.credential, ['push', '-u', 'origin', options.branchName], options.worktreePath)
      if (!push.ok) return {
        deliveryStatus: 'failed', headCommit: head.stdout.trim(), pushStatus: 'failed',
        reviewStatus: 'not_supported', mergeStatus: 'pending', failureCode: 'git_push_failed',
        failureSummary: failureSummary('Git push failed', push),
      }
    }
    return {
      deliveryStatus: 'pushed', headCommit: head.stdout.trim(), pushedCommit: head.stdout.trim(),
      pushStatus: 'pushed', reviewStatus: 'not_supported', mergeStatus: 'pending',
    }
  }
}

export class GitHubGitAdapter extends GenericGitAdapter {
  override readonly provider = 'github'
  override readonly capabilities: GitProviderCapabilities = {
    clone: true,
    fetch: true,
    push: true,
    pullRequest: true,
    review: true,
    merge: true,
  }

  private repositoryArgs(options: ForgePullRequestOptions) {
    if (!options.repository) return []
    const prefix = options.repository.host === 'github.com' ? '' : `${options.repository.host}/`
    return ['-R', `${prefix}${options.repository.namespace}/${options.repository.name}`]
  }

  private normalizePullRequest(value: unknown): ForgePullRequest | null {
    const row = object(value)
    const externalId = String(row.number ?? row.id ?? '')
    const url = text(row.url)
    if (!externalId || !url) return null
    const rawState = String(row.state ?? '').toLowerCase()
    const state: ForgePullRequestState = row.mergedAt || rawState === 'merged'
      ? 'merged'
      : rawState === 'closed'
        ? 'closed'
        : 'open'
    const checks = (Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : []).map((item: unknown) => {
      const check = object(item)
      return {
        name: text(check.name) ?? text(check.context) ?? 'unnamed',
        state: normalizeCheckState(check.conclusion ?? check.state ?? check.status),
        ...(text(check.detailsUrl) ? { url: text(check.detailsUrl)! } : {}),
        ...(text(check.workflowName) ? { summary: text(check.workflowName)! } : {}),
      }
    })
    const approvals = (Array.isArray(row.reviews) ? row.reviews : []).map((item: unknown) => {
      const review = object(item)
      return {
        actorId: text(object(review.author).login) ?? 'unknown',
        state: normalizeApprovalState(review.state),
        ...(text(review.submittedAt) ? { submittedAt: text(review.submittedAt)! } : {}),
        ...(text(review.commit?.oid) ? { headCommit: text(review.commit.oid)! } : {}),
      }
    })
    return {
      provider: 'github',
      externalId,
      url,
      state,
      headCommit: text(row.headRefOid),
      baseCommit: text(row.baseRefOid),
      mergeable: typeof row.mergeable === 'string'
        ? row.mergeable.toLowerCase() === 'mergeable'
        : typeof row.mergeable === 'boolean' ? row.mergeable : null,
      mergeState: text(row.mergeStateStatus),
      checks,
      approvals,
      ...(text(row.updatedAt) ? { updatedAt: text(row.updatedAt)! } : {}),
    }
  }

  override async findPullRequest(options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest | null>> {
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const view = await this.run('gh', [
      'pr', 'view', options.branchName,
      '--json', 'number,url,state,headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviews,mergedAt,updatedAt',
      ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!view.ok) {
      const detail = `${view.stderr}\n${view.stdout}`.toLowerCase()
      if (/no pull requests found|could not resolve to a pull request|not found/.test(detail)) {
        return { ok: true, value: null }
      }
      return { ok: false, failure: forgeFailure('Pull request discovery failed', view, 'forge_pull_request_lookup_failed') }
    }
    const pullRequest = this.normalizePullRequest(parseJson(view.stdout))
    if (!pullRequest) {
      return {
        ok: false,
        failure: {
          code: 'forge_response_invalid',
          summary: 'GitHub returned an invalid pull-request response',
          category: 'infrastructure',
          retry: 'automatic',
        },
      }
    }
    return { ok: true, value: pullRequest }
  }

  override async ensurePullRequest(options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest>> {
    const found = await this.findPullRequest(options)
    if (!found.ok) return found
    if (found.value) return { ok: true, value: found.value }
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const create = await this.run('gh', [
      'pr', 'create', '--base', options.baseBranch, '--head', options.branchName,
      '--title', options.title, '--body', options.body, ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!create.ok) {
      return { ok: false, failure: forgeFailure('Pull request creation failed', create, 'forge_pull_request_failed') }
    }
    const refreshed = await this.findPullRequest(options)
    if (!refreshed.ok) return refreshed
    if (!refreshed.value) {
      return {
        ok: false,
        failure: {
          code: 'forge_pull_request_missing',
          summary: 'GitHub reported successful creation but the pull request could not be rediscovered',
          category: 'infrastructure',
          retry: 'automatic',
        },
      }
    }
    return { ok: true, value: refreshed.value }
  }

  override async postReviewSummary(options: ForgeReviewOptions): Promise<ForgeResult<ForgePullRequest>> {
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const decisionFlag = options.decision === 'approve'
      ? '--approve'
      : options.decision === 'changes_requested'
        ? '--request-changes'
        : '--comment'
    const result = await this.run('gh', [
      'pr', 'review', options.pullRequest.externalId, decisionFlag, '--body', options.summary,
      ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!result.ok) {
      return { ok: false, failure: forgeFailure('Pull request review failed', result, 'forge_review_failed') }
    }
    const refreshed = await this.findPullRequest(options)
    return refreshed.ok && refreshed.value
      ? { ok: true, value: refreshed.value }
      : refreshed.ok
        ? { ok: false, failure: { code: 'forge_pull_request_missing', summary: 'Pull request disappeared after review', category: 'infrastructure', retry: 'automatic' } }
        : refreshed
  }

  override async mergePullRequest(options: ForgeMergeOptions): Promise<ForgeResult<ForgePullRequest>> {
    if (options.pullRequest.state === 'merged') return { ok: true, value: options.pullRequest }
    if (options.pullRequest.headCommit && options.pullRequest.headCommit !== options.expectedHeadCommit) {
      return { ok: false, failure: { code: 'forge_stale_head', summary: 'Pull request head changed after approval', category: 'policy', retry: 'manual' } }
    }
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const result = await this.run('gh', [
      'pr', 'merge', options.pullRequest.externalId, '--merge',
      '--match-head-commit', options.expectedHeadCommit,
      ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!result.ok) {
      return { ok: false, failure: forgeFailure('Pull request merge failed', result, 'forge_merge_failed') }
    }
    const refreshed = await this.findPullRequest(options)
    return refreshed.ok && refreshed.value
      ? { ok: true, value: refreshed.value }
      : refreshed.ok
        ? { ok: false, failure: { code: 'forge_pull_request_missing', summary: 'Pull request disappeared after merge', category: 'infrastructure', retry: 'automatic' } }
        : refreshed
  }

  override async finalize(options: FinalizeRepositoryOptions): Promise<RepositoryDeliveryResult> {
    const result = await super.finalize(options)
    if (result.deliveryStatus === 'failed' || result.deliveryStatus === 'unchanged') return result
    const pullRequest = await this.ensurePullRequest({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      baseBranch: options.baseBranch,
      title: options.title,
      body: options.body,
      credential: options.forgeCredential ?? {
        state: 'unavailable', reasonCode: 'not_resolved', transport: 'https', operation: 'forge',
        policyRevision: 1, checkedAt: new Date().toISOString(),
      },
      repository: options.repository,
    })
    if (!pullRequest.ok) return {
      ...result,
      deliveryStatus: 'failed',
      reviewStatus: 'failed',
      failureCode: pullRequest.failure.code,
      failureSummary: pullRequest.failure.summary,
    }
    return {
      ...result,
      deliveryStatus: 'in_review',
      pullRequestProvider: 'github',
      pullRequestExternalId: pullRequest.value.externalId,
      pullRequestUrl: pullRequest.value.url,
      reviewStatus: 'in_review',
    }
  }
}

export class GiteaGitAdapter extends GenericGitAdapter {
  override readonly provider = 'gitea'
  override readonly capabilities: GitProviderCapabilities = {
    clone: true,
    fetch: true,
    push: true,
    pullRequest: true,
    review: true,
    merge: true,
  }

  private repositoryArgs(options: ForgePullRequestOptions) {
    return options.repository ? ['--repo', `${options.repository.namespace}/${options.repository.name}`] : []
  }

  private normalizePullRequest(value: unknown): ForgePullRequest | null {
    const row = object(value)
    const externalId = String(row.index ?? row.number ?? row.id ?? '')
    const url = text(row.html_url) ?? text(row.url)
    if (!externalId || !url) return null
    const rawState = String(row.state ?? '').toLowerCase()
    const merged = Boolean(row.merged || row.merged_at)
    const checksValue = row.checks ?? row.statuses ?? row.commit_statuses
    const reviewsValue = row.reviews ?? row.approvals
    return {
      provider: 'gitea',
      externalId,
      url,
      state: merged ? 'merged' : rawState === 'closed' ? 'closed' : 'open',
      headCommit: text(object(row.head).sha) ?? text(row.head_sha),
      baseCommit: text(object(row.base).sha) ?? text(row.base_sha),
      mergeable: typeof row.mergeable === 'boolean' ? row.mergeable : null,
      mergeState: text(row.merge_base) ?? text(row.merge_state),
      checks: (Array.isArray(checksValue) ? checksValue : []).map((item: unknown) => {
        const check = object(item)
        return {
          name: text(check.context) ?? text(check.name) ?? 'unnamed',
          state: normalizeCheckState(check.status ?? check.state),
          ...(text(check.target_url) || text(check.url)
            ? { url: (text(check.target_url) ?? text(check.url))! }
            : {}),
          ...(text(check.description) ? { summary: text(check.description)! } : {}),
        }
      }),
      approvals: (Array.isArray(reviewsValue) ? reviewsValue : []).map((item: unknown) => {
        const review = object(item)
        return {
          actorId: text(object(review.user).login_name)
            ?? text(object(review.user).login)
            ?? text(object(review.user).username)
            ?? 'unknown',
          state: normalizeApprovalState(review.state ?? review.type),
          ...(text(review.submitted_at) ? { submittedAt: text(review.submitted_at)! } : {}),
          ...(text(review.commit_id) ? { headCommit: text(review.commit_id)! } : {}),
        }
      }),
      ...(text(row.updated_at) ? { updatedAt: text(row.updated_at)! } : {}),
    }
  }

  override async findPullRequest(options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest | null>> {
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const result = await this.run('tea', [
      'pulls', 'list', '--state', 'all', '--output', 'json', ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!result.ok) {
      return { ok: false, failure: forgeFailure('Pull request discovery failed', result, 'forge_pull_request_lookup_failed') }
    }
    const parsed = parseJson(result.stdout)
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(object(parsed).items) ? object(parsed).items : []
    const match = rows.find((item: unknown) => {
      const row = object(item)
      const head = object(row.head)
      const base = object(row.base)
      return (text(head.ref) ?? text(head.label) ?? text(row.head_branch)) === options.branchName
        && (!text(base.ref) || text(base.ref) === options.baseBranch)
    })
    return { ok: true, value: match ? this.normalizePullRequest(match) : null }
  }

  override async ensurePullRequest(options: ForgePullRequestOptions): Promise<ForgeResult<ForgePullRequest>> {
    const found = await this.findPullRequest(options)
    if (!found.ok) return found
    if (found.value) return { ok: true, value: found.value }
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const create = await this.run('tea', [
      'pulls', 'create', '--base', options.baseBranch, '--head', options.branchName,
      '--title', options.title, '--description', options.body, '--output', 'json',
      ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!create.ok) {
      return { ok: false, failure: forgeFailure('Pull request creation failed', create, 'forge_pull_request_failed') }
    }
    const created = this.normalizePullRequest(parseJson(create.stdout))
    if (created) return { ok: true, value: created }
    const refreshed = await this.findPullRequest(options)
    if (!refreshed.ok) return refreshed
    return refreshed.value
      ? { ok: true, value: refreshed.value }
      : { ok: false, failure: { code: 'forge_pull_request_missing', summary: 'Gitea reported successful creation but the pull request could not be rediscovered', category: 'infrastructure', retry: 'automatic' } }
  }

  private async refreshPullRequest(options: ForgePullRequestOptions, pullRequest: ForgePullRequest) {
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const view = await this.run('tea', [
      'pulls', 'view', pullRequest.externalId, '--output', 'json', ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!view.ok) return { ok: false as const, failure: forgeFailure('Pull request refresh failed', view, 'forge_pull_request_lookup_failed') }
    const normalized = this.normalizePullRequest(parseJson(view.stdout))
    return normalized
      ? { ok: true as const, value: normalized }
      : { ok: false as const, failure: { code: 'forge_response_invalid', summary: 'Gitea returned an invalid pull-request response', category: 'infrastructure' as const, retry: 'automatic' as const } }
  }

  override async postReviewSummary(options: ForgeReviewOptions): Promise<ForgeResult<ForgePullRequest>> {
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const decisionFlag = options.decision === 'approve'
      ? ['--approve']
      : options.decision === 'changes_requested'
        ? ['--request-changes']
        : []
    const review = await this.run('tea', [
      'pulls', 'review', options.pullRequest.externalId, ...decisionFlag,
      '--comment', options.summary, ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!review.ok) {
      return { ok: false, failure: forgeFailure('Pull request review failed', review, 'forge_review_failed') }
    }
    return this.refreshPullRequest(options, options.pullRequest)
  }

  override async mergePullRequest(options: ForgeMergeOptions): Promise<ForgeResult<ForgePullRequest>> {
    if (options.pullRequest.state === 'merged') return { ok: true, value: options.pullRequest }
    if (options.pullRequest.headCommit && options.pullRequest.headCommit !== options.expectedHeadCommit) {
      return { ok: false, failure: { code: 'forge_stale_head', summary: 'Pull request head changed after approval', category: 'policy', retry: 'manual' } }
    }
    const environment = this.forgeEnvironment(options.credential)
    if (!environment.ok) return environment
    const merge = await this.run('tea', [
      'pulls', 'merge', options.pullRequest.externalId, ...this.repositoryArgs(options),
    ], options.worktreePath, environment.value)
    if (!merge.ok) {
      return { ok: false, failure: forgeFailure('Pull request merge failed', merge, 'forge_merge_failed') }
    }
    return this.refreshPullRequest(options, options.pullRequest)
  }

  override async finalize(options: FinalizeRepositoryOptions): Promise<RepositoryDeliveryResult> {
    const result = await super.finalize(options)
    if (result.deliveryStatus === 'failed' || result.deliveryStatus === 'unchanged') return result
    const pullRequest = await this.ensurePullRequest({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      baseBranch: options.baseBranch,
      title: options.title,
      body: options.body,
      credential: options.forgeCredential ?? {
        state: 'unavailable', reasonCode: 'not_resolved', transport: 'https', operation: 'forge',
        policyRevision: 1, checkedAt: new Date().toISOString(),
      },
      repository: options.repository,
    })
    if (!pullRequest.ok) return {
      ...result,
      deliveryStatus: 'failed',
      reviewStatus: 'failed',
      failureCode: pullRequest.failure.code,
      failureSummary: pullRequest.failure.summary,
    }
    return {
      ...result,
      deliveryStatus: 'in_review',
      pullRequestProvider: 'gitea',
      pullRequestExternalId: pullRequest.value.externalId,
      pullRequestUrl: pullRequest.value.url,
      reviewStatus: 'in_review',
    }
  }
}

export function getGitProviderAdapter(provider: string, run: GitRunner = runTrustedGitCommand): GenericGitAdapter {
  if (provider === 'github') return new GitHubGitAdapter(run)
  if (provider === 'gitea') return new GiteaGitAdapter(run)
  return new GenericGitAdapter(run)
}
