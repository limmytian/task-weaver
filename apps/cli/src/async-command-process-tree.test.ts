import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './async-command.js'

test('cancel terminates a managed subprocess group including children ignoring SIGTERM', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-process-tree-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'child-heartbeat')
  const controller = new AbortController()
  const childSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)`
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childSource)},${JSON.stringify(file)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const run = runCommand(process.execPath, ['-e', parent], { signal: controller.signal, killGraceMs: 100, timeoutMs: 5000 })
  for (let i = 0; i < 100; i++) { try { await readFile(file); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) } }
  controller.abort()
  const result = await run
  assert.equal(result.cancelled, true)
  const stopped = await readFile(file, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await readFile(file, 'utf8'), stopped, 'descendant stopped writing before replacement can start')
})
