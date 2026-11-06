import { runCommand } from './async-command.js'
import { buildAiEnvironment } from './repository-credentials.js'

const commitId = /^[0-9a-f]{40}([0-9a-f]{24})?$/
type GitIdentity = { name: string; email: string }
function identityArgs(identity?: GitIdentity) {
  if (!identity) return []
  if (!identity.name.trim() || identity.name.length > 200 || /[\x00-\x1f<>]/.test(identity.name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(identity.email) || identity.email.length > 254) throw new Error('Invalid Git commit identity')
  return ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`]
}

/** Create a task-local commit without granting the executor any push credentials. */
export async function commitThinWorkspace(options: {
  cwd: string
  baseline: string
  message: string
  identity?: GitIdentity
  assertAuthority: () => Promise<void>
  signal?: AbortSignal
}) {
  if (!commitId.test(options.baseline) || !options.message.trim() || options.message.length > 200) throw new Error('Invalid task commit parameters')
  const env = buildAiEnvironment(process.env)
  const identity = identityArgs(options.identity)
  const git = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...identity, ...args], { cwd: options.cwd, env, signal: options.signal })
  await options.assertAuthority()
  const head = await git(['rev-parse', '--verify', 'HEAD'])
  if (!head.ok || head.stdout.trim() !== options.baseline) throw new Error('Task workspace no longer matches its baseline')
  const add = await git(['add', '-A', '--', '.'])
  if (!add.ok) throw new Error('Task changes could not be staged')
  const changed = await git(['diff', '--cached', '--quiet', '--exit-code'])
  if (changed.status === 0) return { commit: options.baseline, changed: false }
  if (changed.status !== 1) throw new Error('Task changes could not be inspected')
  await options.assertAuthority()
  const commit = await git(['commit', '-s', '-m', options.message])
  if (!commit.ok) throw new Error('Task commit failed; inspect the preserved workspace and Git identity')
  const result = await git(['rev-parse', '--verify', 'HEAD'])
  if (!result.ok || !commitId.test(result.stdout.trim())) throw new Error('Task commit could not be verified')
  await options.assertAuthority()
  return { commit: result.stdout.trim(), changed: true }
}

/** Integrate the observed target into the task branch; a conflict remains in the worktree for Codex. */
export async function integrateThinTarget(options: {
  cwd: string
  taskCommit: string
  targetCommit: string
  identity?: GitIdentity
  assertAuthority: () => Promise<void>
  signal?: AbortSignal
}) {
  if (!commitId.test(options.taskCommit) || !commitId.test(options.targetCommit)) throw new Error('Invalid integration commit')
  const env = buildAiEnvironment(process.env)
  const identity = identityArgs(options.identity)
  const git = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...identity, ...args], { cwd: options.cwd, env, signal: options.signal })
  await options.assertAuthority()
  const head = await git(['rev-parse', '--verify', 'HEAD'])
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all'])
  if (!head.ok || head.stdout.trim() !== options.taskCommit || !status.ok || status.stdout.trim()) throw new Error('Integration requires a clean task commit')
  const target = await git(['cat-file', '-e', `${options.targetCommit}^{commit}`])
  if (!target.ok) throw new Error('Target commit is unavailable locally')
  await options.assertAuthority()
  const merge = await git(['merge', '--no-edit', '--no-ff', '--signoff', options.targetCommit])
  if (!merge.ok) throw new Error('Target integration requires conflict resolution in the preserved workspace')
  const result = await git(['rev-parse', '--verify', 'HEAD'])
  if (!result.ok || !commitId.test(result.stdout.trim())) throw new Error('Integrated commit could not be verified')
  const includesTarget = await git(['merge-base', '--is-ancestor', options.targetCommit, result.stdout.trim()])
  const includesTask = await git(['merge-base', '--is-ancestor', options.taskCommit, result.stdout.trim()])
  if (!includesTarget.ok || !includesTask.ok) throw new Error('Integrated commit does not contain both inputs')
  await options.assertAuthority()
  return { commit: result.stdout.trim() }
}

/** Submit only a normal fast-forward push. A transport failure after authorization is always uncertain. */
export async function pushThinDelivery(options: {
  targetBranch: string
  expectedHead: string
  proposedHead: string
  git: (args: string[]) => Promise<{ ok: boolean; status: number | null; stdout: string; stderr: string }>
  authorizePush: () => Promise<boolean>
  markUncertain: () => Promise<void>
}) {
  if (!commitId.test(options.expectedHead) || !commitId.test(options.proposedHead) || !options.targetBranch || options.targetBranch.length > 255) throw new Error('Invalid push parameters')
  const valid = await options.git(['check-ref-format', '--branch', options.targetBranch])
  if (!valid.ok) throw new Error('Invalid target branch')
  const head = await options.git(['rev-parse', '--verify', 'HEAD'])
  if (!head.ok || head.stdout.trim() !== options.proposedHead) throw new Error('Proposed commit is not checked out')
  const ancestry = await options.git(['merge-base', '--is-ancestor', options.expectedHead, options.proposedHead])
  if (!ancestry.ok) throw new Error('Proposed commit does not contain the expected target')
  const ref = `refs/heads/${options.targetBranch}`
  const remote = await options.git(['ls-remote', '--exit-code', 'origin', ref])
  if (!remote.ok || remote.stdout.trim() !== `${options.expectedHead}\t${ref}`) throw new Error('Target branch advanced; integrate its latest commit')
  if (!await options.authorizePush()) throw new Error('Push authorization was not newly granted')
  try {
    const push = await options.git(['push', '--porcelain', 'origin', `${options.proposedHead}:${ref}`])
    if (push.ok) return { state: 'submitted' as const }
  } catch { /* The remote may already have accepted the update. */ }
  await options.markUncertain()
  return { state: 'uncertain' as const }
}
