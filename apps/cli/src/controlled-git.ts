import { runCommand } from './async-command.js'
import { getGitProviderAdapter, runTrustedGitCommand } from './git-provider.js'
import { resolveRepositoryCredential } from './repository-credentials.js'
import type { Config } from './config.js'
import type { CompositeWorkspace, RequirementRepositoryEntry } from './repository-workspace.js'

/** Small credential-isolated operations. The agent owns merge/rebase and conflict resolution. */
export function createControlledGit(options: {
  config: Config
  workspace: CompositeWorkspace
  entries: RequirementRepositoryEntry[]
  signal?: AbortSignal
  assertAuthority: () => Promise<void>
  record: (input: { repositoryId: string; remoteTip: string; localHead: string; fetchedAt: string }) => Promise<unknown>
}) {
  const unexpectedRewrites = new Set<string>()
  return async (input: { operation: 'fetch' | 'verify'; repositoryId: string }) => {
    const entry = options.entries.find(entry => entry.repository.id === input.repositoryId)
    const workspace = options.workspace.repositories.find(repo => repo.repositoryId === input.repositoryId)
    if (!entry || !workspace) throw new Error('Repository is outside this execution workspace')
    if (!['fetch', 'verify'].includes(input.operation)) throw new Error('Unsupported controlled Git operation')
    await options.assertAuthority()
    const credential = resolveRepositoryCredential(options.config, entry.repository, 'read')
    if (credential.state !== 'available') throw new Error('Repository read credential is unavailable')
    const adapter = getGitProviderAdapter(entry.repository.provider, (command, args, cwd, environment) => runTrustedGitCommand(command, args, cwd, environment, options.signal))
    const previousTip = await runCommand('git', ['rev-parse', '--verify', `refs/remotes/origin/${workspace.workingBranch}`], { cwd: workspace.worktreePath, signal: options.signal })
    const fetched = await adapter.git(credential, ['fetch', '--prune', 'origin'], workspace.worktreePath)
    if (!fetched.ok) throw new Error('Target branch fetch failed; execution is blocked')
    const fetchedAt = new Date().toISOString()
    const local = (args: string[]) => runCommand('git', args, { cwd: workspace.worktreePath, signal: options.signal })
    const target = await local(['rev-parse', '--verify', `refs/remotes/origin/${workspace.workingBranch}`])
    // A new target branch starts from its configured base, without inventing a handoff commit.
    const baseline = target.ok ? target : await local(['rev-parse', '--verify', `refs/remotes/origin/${workspace.baseBranch}`])
    if (!baseline.ok) throw new Error('Target branch and base are unavailable; execution is blocked')
    const remoteTip = baseline.stdout.trim()
    if (previousTip.ok) {
      const descends = target.ok ? await local(['merge-base', '--is-ancestor', previousTip.stdout.trim(), remoteTip]) : null
      if (!descends?.ok) unexpectedRewrites.add(input.repositoryId)
    }
    const head = await local(['rev-parse', 'HEAD'])
    const status = await local(['status', '--porcelain'])
    if (!head.ok || !status.ok) throw new Error('Workspace cannot be inspected')
    const included = await local(['merge-base', '--is-ancestor', remoteTip, 'HEAD'])
    await options.assertAuthority()
    if (input.operation === 'verify') {
      if (unexpectedRewrites.has(input.repositoryId)) throw new Error('Target branch history was rewritten or deleted; inspect provenance and request a fresh execution after manual review')
      if (!included.ok) throw new Error('Latest observed target tip is not in working history; merge/rebase and validate before retrying')
      await options.record({ repositoryId: input.repositoryId, remoteTip, localHead: head.stdout.trim(), fetchedAt })
    }
    return { repositoryId: input.repositoryId, operation: input.operation, targetBranch: workspace.workingBranch, remoteTip, fetchedAt, localHead: head.stdout.trim(), includesRemoteTip: included.ok, remoteRewritten: unexpectedRewrites.has(input.repositoryId), dirty: Boolean(status.stdout.trim()), status: status.stdout,
      instructions: 'Inspect preserved work against the latest plan. Use local Git to merge/rebase and resolve conflicts, validate, then request verify. Report blocked if synchronization cannot be completed. Do not force push.' }
  }
}
