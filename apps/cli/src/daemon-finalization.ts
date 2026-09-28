import { runCommand } from './async-command.js'
import { redactTrustedOutput } from './repository-credentials.js'

export interface RequirementForFinalization {
  id: string
  title: string
}

export interface ShellResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  command: string
}

export type CommandRunner = (command: string, args: string[], cwd: string) => ShellResult | Promise<ShellResult>

export interface BranchFinalizationResult {
  branchName: string
  commitSha: string | null
  commitCreated: boolean
  pushSucceeded: boolean
  prUrl: string | null
  summary: string
}

export interface FinalizeRequirementBranchOptions {
  requirement: RequirementForFinalization
  branchName: string | null
  worktreePath: string | null
  commentTaskId: string | null
  run?: CommandRunner
  addTaskComment?: (taskId: string, content: string) => Promise<void>
}

export async function runShell(command: string, args: string[], cwd: string): Promise<ShellResult> {
  const result = await runCommand(command, args, {
    cwd,
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024,
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

export function commandFailureSummary(result: ShellResult): string {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
  return output || `exit ${result.status ?? 'unknown'}`
}

function commitSubject(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Task Weaver daemon changes'
}

export async function finalizeRequirementBranch({
  requirement,
  branchName,
  worktreePath,
  commentTaskId,
  run = runShell,
  addTaskComment,
}: FinalizeRequirementBranchOptions): Promise<BranchFinalizationResult> {
  const writeComment = async (content: string) => {
    if (commentTaskId && addTaskComment) {
      await addTaskComment(commentTaskId, content)
    }
  }

  if (!branchName || !worktreePath) {
    const summary = 'Daemon finalization could not publish a branch because branch name or worktree path was missing.'
    await writeComment(summary)
    return { branchName: branchName ?? '', commitSha: null, commitCreated: false, pushSucceeded: false, prUrl: null, summary }
  }

  const summaryLines = [
    'Daemon finalization summary:',
    `- Requirement: ${requirement.title} (${requirement.id})`,
    `- Branch: ${branchName}`,
    `- Worktree: ${worktreePath}`,
  ]

  let commitCreated = false
  let commitSha: string | null = null
  let pushSucceeded = false
  let prUrl: string | null = null
  let localChangeFailure = false

  const status = await run('git', ['status', '--porcelain'], worktreePath)
  if (!status.ok) {
    summaryLines.push(`- Git status: failed (${commandFailureSummary(status)})`)
    localChangeFailure = true
  } else if (status.stdout) {
    const add = await run('git', ['add', '-A'], worktreePath)
    if (!add.ok) {
      summaryLines.push(`- Commit: failed during git add (${commandFailureSummary(add)})`)
      localChangeFailure = true
    } else {
      const staged = await run('git', ['diff', '--cached', '--quiet'], worktreePath)
      if (staged.status === 0) {
        summaryLines.push('- Commit: no staged changes after git add; no commit created.')
      } else if (staged.status !== 1) {
        summaryLines.push(`- Commit: failed while checking staged diff (${commandFailureSummary(staged)})`)
        localChangeFailure = true
      } else {
        const commit = await run('git', ['commit', '-m', `feat: ${commitSubject(requirement.title)}`], worktreePath)
        if (commit.ok) {
          commitCreated = true
          summaryLines.push('- Commit: created from daemon-owned worktree changes.')
        } else {
          summaryLines.push(`- Commit: failed (${commandFailureSummary(commit)})`)
          localChangeFailure = true
        }
      }
    }
  } else {
    summaryLines.push('- Commit: no local file changes detected; no new commit created.')
  }

  const head = await run('git', ['rev-parse', '--short', 'HEAD'], worktreePath)
  if (head.ok && head.stdout) {
    commitSha = head.stdout
    summaryLines.push(`- HEAD: ${commitSha}${commitCreated ? ' (new commit)' : ''}`)
  } else {
    summaryLines.push(`- HEAD: unavailable (${commandFailureSummary(head)})`)
  }

  if (localChangeFailure) {
    summaryLines.push('- Push: skipped because local changes could not be safely committed.')
  } else {
    const push = await run('git', ['push', '-u', 'origin', branchName], worktreePath)
    if (push.ok) {
      pushSucceeded = true
      summaryLines.push('- Push: branch published to origin.')
    } else {
      summaryLines.push(`- Push: failed (${commandFailureSummary(push)})`)
    }
  }

  if (pushSucceeded) {
    const ghVersion = await run('gh', ['--version'], worktreePath)
    if (!ghVersion.ok) {
      summaryLines.push('- PR: gh CLI unavailable; branch is pushed and needs manual PR creation.')
    } else {
      const view = await run('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], worktreePath)
      if (view.ok && view.stdout) {
        prUrl = view.stdout
        summaryLines.push(`- PR: existing PR found at ${prUrl}.`)
      } else {
        const body = [
          `Task Weaver requirement: ${requirement.title}`,
          '',
          `Requirement ID: ${requirement.id}`,
          `Branch: ${branchName}`,
          '',
          'Created by tw daemon finalization after all requirement tasks reached a terminal state.',
        ].join('\n')
        const create = await run('gh', ['pr', 'create', '--base', 'main', '--head', branchName, '--title', requirement.title, '--body', body], worktreePath)
        if (create.ok && create.stdout) {
          prUrl = create.stdout.split(/\r?\n/).find(line => line.startsWith('http')) ?? create.stdout
          summaryLines.push(`- PR: created at ${prUrl}.`)
        } else {
          const viewAfterCreate = await run('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], worktreePath)
          if (viewAfterCreate.ok && viewAfterCreate.stdout) {
            prUrl = viewAfterCreate.stdout
            summaryLines.push(`- PR: found after create retry at ${prUrl}.`)
          } else {
            summaryLines.push(`- PR: creation failed (${commandFailureSummary(create)}). Branch is pushed and needs manual PR review.`)
          }
        }
      }
    }
  }

  summaryLines.push('- Requirement status: moved to in_review for human review.')
  const summary = summaryLines.join('\n')
  await writeComment(summary)
  return { branchName, commitSha, commitCreated, pushSucceeded, prUrl, summary }
}
