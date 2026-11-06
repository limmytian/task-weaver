import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commitThinWorkspace } from './thin-git-delivery.js'

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
  const result = await commitThinWorkspace({ cwd, baseline, message: 'Task delivery', assertAuthority: async () => {} })
  assert.equal(result.changed, true)
  assert.equal(git('rev-parse', 'HEAD'), result.commit)
  assert.equal(git('rev-parse', 'HEAD^'), baseline)
  assert.match(git('log', '-1', '--format=%B'), /Signed-off-by: Fixture <fixture@example.test>/)
  await assert.rejects(commitThinWorkspace({ cwd, baseline, message: 'Stale', assertAuthority: async () => {} }), /baseline/)
})
