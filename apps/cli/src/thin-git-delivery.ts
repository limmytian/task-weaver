import { runCommand } from './async-command.js'
import { buildAiEnvironment } from './repository-credentials.js'

const commitId = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Create a task-local commit without granting the executor any push credentials. */
export async function commitThinWorkspace(options: {
  cwd: string
  baseline: string
  message: string
  assertAuthority: () => Promise<void>
  signal?: AbortSignal
}) {
  if (!commitId.test(options.baseline) || !options.message.trim() || options.message.length > 200) throw new Error('Invalid task commit parameters')
  const env = buildAiEnvironment(process.env)
  const git = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: options.cwd, env, signal: options.signal })
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
