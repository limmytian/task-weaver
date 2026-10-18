import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('stdio startup rejects missing credentials without contaminating stdout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-mcp-missing-key-'))
  try {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./index.ts', import.meta.url)), 'mcp', 'serve'], {
      env: { ...process.env, TW_CONFIG_DIR: directory, TW_API_KEY: '', TW_API_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /requires a configured Task Weaver API key/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
