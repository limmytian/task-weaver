import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commitThinWorkspace, integrateThinTarget, pushThinDelivery } from './thin-git-delivery.js'
import { runCommand } from './async-command.js'

test('task commits preserve the baseline and refuse lost authority', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tw-git-delivery-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await writeFile(join(cwd, 'file.txt'), 'baseline\n')
  git('add', 'file.txt')
  git('commit', '-m', 'baseline')
  const baseline = git('rev-parse', 'HEAD')
  await writeFile(join(cwd, 'file.txt'), 'changed\n')
  await assert.rejects(commitThinWorkspace({ cwd, baseline, message: 'Task', assertAuthority: async () => { throw new Error('expired') } }), /expired/)
  assert.equal(git('rev-parse', 'HEAD'), baseline)
  const result = await commitThinWorkspace({ cwd, baseline, message: 'Task delivery', identity: { name: 'Delivery Operator', email: 'delivery@example.test' }, assertAuthority: async () => {} })
  assert.equal(result.changed, true)
  assert.equal(git('rev-parse', 'HEAD'), result.commit)
  assert.equal(git('rev-parse', 'HEAD^'), baseline)
  assert.match(git('log', '-1', '--format=%B'), /Signed-off-by: Delivery Operator <delivery@example.test>/)
  await assert.rejects(commitThinWorkspace({ cwd, baseline, message: 'Stale', assertAuthority: async () => {} }), /baseline/)
})

test('normal push refuses an advanced branch and preserves uncertainty after a lost response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-git-push-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), remote = join(root, 'remote.git')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false' }
  execFileSync('git', ['init', '--bare', remote], { env, stdio: 'ignore' })
  execFileSync('git', ['clone', remote, cwd], { env, stdio: 'ignore' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
  git('switch', '-c', 'requirement')
  await writeFile(join(cwd, 'file.txt'), 'one\n'); git('add', '.'); git('commit', '-m', 'base'); git('push', 'origin', 'HEAD:refs/heads/requirement')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(cwd, 'file.txt'), 'two\n'); git('add', '.'); git('commit', '-m', 'delivery')
  const proposed = git('rev-parse', 'HEAD')
  let starts = 0, uncertain = 0
  const run = (args: string[]) => runCommand('git', args, { cwd, env })
  const result = await pushThinDelivery({ targetBranch: 'requirement', expectedHead: base, proposedHead: proposed, git: async args => {
    const actual = await run(args)
    return args[0] === 'push' ? { ...actual, ok: false, status: null, stderr: 'connection lost' } : actual
  }, authorizePush: async () => { starts++; return true }, markUncertain: async () => { uncertain++ } })
  assert.equal(result.state, 'uncertain'); assert.equal(starts, 1); assert.equal(uncertain, 1)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/requirement').split('\t')[0], proposed)
  await assert.rejects(pushThinDelivery({ targetBranch: 'requirement', expectedHead: base, proposedHead: proposed, git: run, authorizePush: async () => { starts++; return true }, markUncertain: async () => {} }), /advanced/)
  assert.equal(starts, 1, 'an advanced target must be rejected before push authorization')
})

test('parallel task integrates the latest target and preserves real conflicts', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tw-git-integrate-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await writeFile(join(cwd, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const baseline = git('rev-parse', 'HEAD')
  git('switch', '-c', 'task')
  await writeFile(join(cwd, 'task.txt'), 'task\n')
  git('add', '.')
  git('commit', '-m', 'task')
  const taskCommit = git('rev-parse', 'HEAD')
  git('switch', '-c', 'target', baseline)
  await writeFile(join(cwd, 'target.txt'), 'target\n')
  git('add', '.')
  git('commit', '-m', 'target')
  const targetCommit = git('rev-parse', 'HEAD')
  git('switch', 'task')
  const integrated = await integrateThinTarget({ cwd, taskCommit, targetCommit, assertAuthority: async () => {} })
  assert.equal(git('rev-parse', 'HEAD'), integrated.commit)
  assert.equal(git('merge-base', '--is-ancestor', targetCommit, integrated.commit), '')
  git('switch', '-c', 'conflict-task', baseline)
  await writeFile(join(cwd, 'base.txt'), 'task side\n')
  git('add', '.')
  git('commit', '-m', 'task conflict')
  const conflictTask = git('rev-parse', 'HEAD')
  git('switch', '-c', 'conflict-target', baseline)
  await writeFile(join(cwd, 'base.txt'), 'target side\n')
  git('add', '.')
  git('commit', '-m', 'target conflict')
  const conflictTarget = git('rev-parse', 'HEAD')
  git('switch', 'conflict-task')
  await assert.rejects(integrateThinTarget({ cwd, taskCommit: conflictTask, targetCommit: conflictTarget, assertAuthority: async () => {} }), /conflict resolution/)
  assert.match(git('status', '--porcelain'), /UU base.txt/)
})
