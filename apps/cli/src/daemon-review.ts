import { runCommand } from './async-command.js'
import { redactTrustedOutput } from './repository-credentials.js'
import {
  commandFailureSummary,
  runShell,
  type CommandRunner,
  type RequirementForFinalization,
  type ShellResult,
} from './daemon-finalization.js'

export interface ReviewDecision {
  approved: boolean
  summary: string
}

export interface ReviewMergeResult {
  status: 'approved' | 'merged' | 'changes_requested' | 'conflict' | 'failed' | 'skipped'
  summary: string
  outcomeCode?: string
  reviewPolicyDecision?: 'satisfied' | 'bypassed' | 'blocked'
  reviewPolicyEvidence?: ReviewPolicyEvidence[]
}

export type ReviewPolicyEvidence = 'configured_checks' | 'ai_review' | 'human_approval' | 'forge_approval'

export interface ReviewMergeRequirement extends RequirementForFinalization {
  projectId: string
}

export type RequirementDaemonStatus = 'in_progress' | 'in_review' | 'ready_to_merge' | 'done'
export type ShellCommandRunner = (command: string, cwd: string) => ShellResult | Promise<ShellResult>
export type AiReviewRunner = (prompt: string, cwd: string) => Promise<ReviewDecision>

interface ReviewCallbacks {
  addTaskComment?: (taskId: string, content: string) => Promise<void>
  createFollowupTask?: (input: { title: string; description: string }) => Promise<void>
  updateRequirementStatus?: (status: RequirementDaemonStatus) => Promise<void>
  onPrepared?: (input: { headCommit: string; baseCommit: string }) => Promise<void>
  onCheckResult?: (input: { name: string; result: ShellResult }) => Promise<void>
  onAiDecision?: (decision: ReviewDecision) => Promise<void>
}

export interface ReviewRequirementBranchOptions extends ReviewCallbacks {
  requirement: ReviewMergeRequirement
  branchName: string | null
  worktreePath: string | null
  commentTaskId: string | null
  baseBranch?: string
  checks?: string[]
  extraPrompt?: string
  run?: CommandRunner
  runCheck?: ShellCommandRunner
  runAiReview?: AiReviewRunner
  approvalEvidence?: ReviewPolicyEvidence[]
  allowUnreviewed?: boolean
}

export interface MergeRequirementBranchOptions extends ReviewCallbacks {
  requirement: ReviewMergeRequirement
  branchName: string | null
  mergeWorktreePath: string | null
  commentTaskId: string | null
  baseBranch?: string
  run?: CommandRunner
  baseUpdateRetries?: number
}

export interface ReviewAndMergeOptions extends ReviewRequirementBranchOptions {
  mergeWorktreePath: string | null
  merge?: boolean
}

export async function runShellCommand(command: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  const result = await runCommand(command, [], {
    cwd,
    shell: true,
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 10 * 1024 * 1024,
    signal,
    redact: redactTrustedOutput,
  })
  return {
    ok: result.ok,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    command: result.command,
  }
}

export function parseReviewDecision(output: string): ReviewDecision {
  const decision = output.match(/REVIEW_DECISION:\s*(approve|changes_requested)/i)?.[1]?.toLowerCase()
  if (decision === 'approve') {
    return { approved: true, summary: output.trim() || 'Review approved.' }
  }
  return { approved: false, summary: output.trim() || 'Review requested changes.' }
}

export function buildReviewPrompt({
  requirement,
  branchName,
  baseBranch,
  checks,
  extraPrompt,
}: {
  requirement: ReviewMergeRequirement
  branchName: string
  baseBranch: string
  checks: string[]
  extraPrompt?: string
}): string {
  const checkText = checks.length > 0 ? checks.map((cmd) => `- ${cmd}`).join('\n') : '- No explicit check commands were configured.'
  const extra = extraPrompt
    ? `\nLocal Extra Worker Instructions:\n${extraPrompt}\n`
    : ''

  return `You are reviewing a Task Weaver requirement branch before it is marked ready to merge.

Requirement:
- ID: ${requirement.id}
- Title: ${requirement.title}
- Branch: ${branchName}
- Base branch: ${baseBranch}

Configured checks:
${checkText}
${extra}
Review the committed diff from origin/${baseBranch} to HEAD. Do not modify files.

Return a concise review with exactly one final decision line:
- REVIEW_DECISION: approve
- REVIEW_DECISION: changes_requested
`
}

function gitFailureLine(label: string, result: ShellResult): string {
  return `- ${label}: failed (${commandFailureSummary(result)})`
}

async function writeComment(commentTaskId: string | null, addTaskComment: ReviewCallbacks['addTaskComment'], content: string) {
  if (commentTaskId && addTaskComment) {
    await addTaskComment(commentTaskId, content)
  }
}

async function routeBackForRework(
  options: ReviewCallbacks,
  title: string,
  description: string,
) {
  if (options.createFollowupTask) {
    await options.createFollowupTask({ title, description })
  }
  if (options.updateRequirementStatus) {
    await options.updateRequirementStatus('in_progress')
  }
}

export async function reviewRequirementBranch(options: ReviewRequirementBranchOptions): Promise<ReviewMergeResult> {
  const {
    requirement,
    branchName,
    worktreePath,
    commentTaskId,
    baseBranch = 'main',
    checks = [],
    extraPrompt,
    run = runShell,
    runCheck = runShellCommand,
    runAiReview,
    approvalEvidence = [],
    allowUnreviewed = false,
    addTaskComment,
    updateRequirementStatus,
    onPrepared,
    onCheckResult,
    onAiDecision,
  } = options

  const reviewPolicyEvidence = [
    ...(checks.length > 0 ? ['configured_checks' as const] : []),
    ...(runAiReview ? ['ai_review' as const] : []),
    ...approvalEvidence,
  ].filter((value, index, values) => values.indexOf(value) === index)
  const reviewPolicyDecision: NonNullable<ReviewMergeResult['reviewPolicyDecision']> = reviewPolicyEvidence.length > 0
    ? 'satisfied'
    : allowUnreviewed
      ? 'bypassed'
      : 'blocked'

  const summaryLines = [
    'Daemon review summary:',
    `- Requirement: ${requirement.title} (${requirement.id})`,
    `- Branch: ${branchName ?? '(missing)'}`,
    `- Base branch: ${baseBranch}`,
  ]

  const finish = async (
    status: ReviewMergeResult['status'],
    outcomeCode?: string,
  ): Promise<ReviewMergeResult> => {
    const summary = summaryLines.join('\n')
    await writeComment(commentTaskId, addTaskComment, summary)
    return {
      status,
      summary,
      ...(outcomeCode ? { outcomeCode } : {}),
      reviewPolicyDecision,
      reviewPolicyEvidence,
    }
  }

  if (reviewPolicyDecision === 'blocked') {
    summaryLines.push('- Review policy: blocked; no configured checks, AI review, human approval, or forge approval was available.')
    summaryLines.push('- Review result: requirement remains in_review for explicit policy remediation.')
    if (updateRequirementStatus) await updateRequirementStatus('in_review')
    return finish('skipped', 'review_policy_unavailable')
  }
  if (reviewPolicyDecision === 'bypassed') {
    summaryLines.push('- Review policy: UNSAFE BYPASS explicitly enabled; approval will be audited without review evidence.')
  } else {
    summaryLines.push(`- Review policy: satisfied by ${reviewPolicyEvidence.join(', ')}.`)
  }

  if (!branchName || !worktreePath) {
    summaryLines.push('- Review: skipped because branch name or worktree path was missing.')
    return finish('skipped', 'review_skipped')
  }

  const status = await run('git', ['status', '--porcelain'], worktreePath)
  if (!status.ok) {
    summaryLines.push(gitFailureLine('Git status', status))
    return finish('failed', 'git_status_failed')
  }
  if (status.stdout) {
    summaryLines.push('- Git status: worktree is dirty; review skipped to avoid mixing local changes.')
    return finish('failed', 'review_worktree_dirty')
  }

  const fetch = await run('git', ['fetch', 'origin'], worktreePath)
  if (!fetch.ok) {
    summaryLines.push(gitFailureLine('Fetch', fetch))
    return finish('failed', 'git_fetch_failed')
  }

  const checkout = await run('git', ['checkout', branchName], worktreePath)
  if (!checkout.ok) {
    summaryLines.push(gitFailureLine('Checkout branch', checkout))
    return finish('failed', 'git_checkout_failed')
  }

  const mergeBase = await run('git', ['merge', '--no-ff', '--no-edit', `origin/${baseBranch}`], worktreePath)
  if (!mergeBase.ok) {
    await run('git', ['merge', '--abort'], worktreePath)
    summaryLines.push(gitFailureLine(`Merge origin/${baseBranch} into review branch`, mergeBase))
    summaryLines.push('- Review result: branch needs conflict resolution before review can continue.')
    const summary = summaryLines.join('\n')
    await routeBackForRework(
      options,
      `Resolve merge conflicts for ${requirement.title}`,
      summary,
    )
    await writeComment(commentTaskId, addTaskComment, summary)
    return { status: 'conflict', summary, outcomeCode: 'review_conflict' }
  }
  summaryLines.push(`- Base sync: merged origin/${baseBranch} into ${branchName}.`)

  const pushBranch = await run('git', ['push', 'origin', branchName], worktreePath)
  if (!pushBranch.ok) {
    summaryLines.push(gitFailureLine('Push review branch', pushBranch))
    return finish('failed', 'git_push_failed')
  }
  summaryLines.push('- Push: review branch is up to date on origin.')

  if (onPrepared) {
    const [head, base] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], worktreePath),
      run('git', ['rev-parse', `origin/${baseBranch}`], worktreePath),
    ])
    if (!head.ok || !base.ok || !head.stdout.trim() || !base.stdout.trim()) {
      summaryLines.push('- Review audit: failed to resolve the reviewed head/base commits.')
      return finish('failed', 'review_commit_resolution_failed')
    }
    await onPrepared({ headCommit: head.stdout.trim(), baseCommit: base.stdout.trim() })
  }

  for (const check of checks) {
    const result = await runCheck(check, worktreePath)
    if (onCheckResult) await onCheckResult({ name: check, result })
    if (!result.ok) {
      summaryLines.push(`- Check failed: ${check}`)
      summaryLines.push(commandFailureSummary(result))
      const summary = summaryLines.join('\n')
      await routeBackForRework(
        options,
        `Fix review check failure for ${requirement.title}`,
        summary,
      )
      await writeComment(commentTaskId, addTaskComment, summary)
      return { status: 'changes_requested', summary, outcomeCode: 'review_check_failed' }
    }
    summaryLines.push(`- Check passed: ${check}`)
  }

  if (runAiReview) {
    const prompt = buildReviewPrompt({ requirement, branchName, baseBranch, checks, extraPrompt })
    const review = await runAiReview(prompt, worktreePath)
    if (onAiDecision) await onAiDecision(review)
    summaryLines.push('- AI review:')
    summaryLines.push(review.summary)
    if (!review.approved) {
      const summary = summaryLines.join('\n')
      await routeBackForRework(
        options,
        `Address review feedback for ${requirement.title}`,
        summary,
      )
      await writeComment(commentTaskId, addTaskComment, summary)
      return { status: 'changes_requested', summary, outcomeCode: 'ai_review_changes_requested' }
    }
  } else {
    summaryLines.push('- AI review: skipped; no review tool was configured.')
  }

  if (updateRequirementStatus) await updateRequirementStatus('ready_to_merge')
  summaryLines.push('- Review result: approved; requirement moved to ready_to_merge.')
  return finish('approved', reviewPolicyDecision === 'bypassed' ? 'review_policy_bypassed' : undefined)
}

export async function mergeRequirementBranch(options: MergeRequirementBranchOptions): Promise<ReviewMergeResult> {
  const {
    requirement,
    branchName,
    mergeWorktreePath,
    commentTaskId,
    baseBranch = 'main',
    run = runShell,
    addTaskComment,
    updateRequirementStatus,
    baseUpdateRetries = 1,
  } = options

  const summaryLines = [
    'Daemon merge summary:',
    `- Requirement: ${requirement.title} (${requirement.id})`,
    `- Branch: ${branchName ?? '(missing)'}`,
    `- Base branch: ${baseBranch}`,
  ]

  const finish = async (
    status: ReviewMergeResult['status'],
    outcomeCode?: string,
  ): Promise<ReviewMergeResult> => {
    const summary = summaryLines.join('\n')
    await writeComment(commentTaskId, addTaskComment, summary)
    return outcomeCode ? { status, summary, outcomeCode } : { status, summary }
  }

  if (!branchName || !mergeWorktreePath) {
    summaryLines.push('- Merge: skipped because branch name or merge worktree path was missing.')
    return finish('skipped', 'merge_skipped')
  }

  const boundedBaseUpdateRetries = Math.max(0, Math.min(Math.trunc(baseUpdateRetries), 3))
  for (let attempt = 0; attempt <= boundedBaseUpdateRetries; attempt += 1) {
    const mergeFetch = await run('git', ['fetch', 'origin'], mergeWorktreePath)
    if (!mergeFetch.ok) {
      summaryLines.push(gitFailureLine('Merge worktree fetch', mergeFetch))
      return finish('failed', 'git_fetch_failed')
    }
    const reset = await run('git', ['reset', '--hard', `origin/${baseBranch}`], mergeWorktreePath)
    if (!reset.ok) {
      summaryLines.push(gitFailureLine(`Reset merge worktree to origin/${baseBranch}`, reset))
      return finish('failed', 'git_reset_failed')
    }
    const clean = await run('git', ['clean', '-fd'], mergeWorktreePath)
    if (!clean.ok) {
      summaryLines.push(gitFailureLine('Clean merge worktree', clean))
      return finish('failed', 'git_clean_failed')
    }

    const mergeBranch = await run('git', ['merge', '--no-ff', '--no-edit', `origin/${branchName}`], mergeWorktreePath)
    if (!mergeBranch.ok) {
      await run('git', ['merge', '--abort'], mergeWorktreePath)
      summaryLines.push(gitFailureLine(`Merge origin/${branchName} into ${baseBranch}`, mergeBranch))
      if (attempt > 0) {
        summaryLines.push('- Merge result: base advanced during publication and now needs a later merge retry.')
        return finish('failed', 'merge_base_advanced')
      }
      summaryLines.push('- Merge result: base merge conflict; branch routed back for manual resolution.')
      const summary = summaryLines.join('\n')
      await routeBackForRework(
        options,
        `Resolve final merge conflicts for ${requirement.title}`,
        summary,
      )
      await writeComment(commentTaskId, addTaskComment, summary)
      return { status: 'conflict', summary, outcomeCode: 'merge_conflict' }
    }

    const pushMain = await run('git', ['push', 'origin', `HEAD:${baseBranch}`], mergeWorktreePath)
    if (pushMain.ok) break
    const pushDetail = `${pushMain.stderr}\n${pushMain.stdout}`
    const baseAdvanced = /non-fast-forward|fetch first|stale info|rejected.*head/i.test(pushDetail)
    const branchPolicyRejected = /protected branch|required (?:status )?check|required review|branch policy|permission to .* denied/i.test(pushDetail)
    if (baseAdvanced && attempt < boundedBaseUpdateRetries) {
      summaryLines.push(`- Base branch changed during push; refreshing and retrying (${attempt + 1}/${boundedBaseUpdateRetries}).`)
      continue
    }
    summaryLines.push(gitFailureLine(`Push ${baseBranch}`, pushMain))
    return finish(
      'failed',
      baseAdvanced
        ? 'merge_base_update_retry_exhausted'
        : branchPolicyRejected
          ? 'branch_policy_rejected'
          : 'git_push_failed',
    )
  }

  summaryLines.push(`- Merge: pushed reviewed branch to ${baseBranch}.`)
  if (updateRequirementStatus) await updateRequirementStatus('done')
  summaryLines.push('- Requirement status: moved to done.')
  return finish('merged')
}

export async function reviewAndMergeRequirementBranch(options: ReviewAndMergeOptions): Promise<ReviewMergeResult> {
  const review = await reviewRequirementBranch(options)
  if (!options.merge || review.status !== 'approved') return review
  return mergeRequirementBranch({
    requirement: options.requirement,
    branchName: options.branchName,
    mergeWorktreePath: options.mergeWorktreePath,
    commentTaskId: options.commentTaskId,
    baseBranch: options.baseBranch,
    run: options.run,
    addTaskComment: options.addTaskComment,
    createFollowupTask: options.createFollowupTask,
    updateRequirementStatus: options.updateRequirementStatus,
  })
}
