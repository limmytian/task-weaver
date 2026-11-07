import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexThinExecutor } from './thin-worker.js'

test('Codex adapter enforces a timeout and detects bounded provider quota failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-thin-codex-'))
  try {
    const bin = join(root, 'bin'); await mkdir(bin)
    const command = join(bin, 'codex')
    await writeFile(command, `#!/usr/bin/env node\nif (process.env.THIN_FIXTURE_MODE === 'quota') console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } })); else setInterval(() => {}, 1000)\n`)
    await chmod(command, 0o700)
    const adapter = codexThinExecutor()
    const input = { prompt: 'fixture', cwd: root, environment: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, THIN_FIXTURE_MODE: 'timeout' }, model: 'fixture', effort: 'low', signal: new AbortController().signal, timeoutMs: 100 }
    const timeout = await adapter.execute(input)
    assert.equal(timeout.ok, false); assert.match(timeout.reason, /timed out/)
    const quota = await adapter.execute({ ...input, timeoutMs: 2000, environment: { ...input.environment, THIN_FIXTURE_MODE: 'quota' } })
    assert.equal(quota.ok, false); assert.equal(quota.quotaBlocked, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
