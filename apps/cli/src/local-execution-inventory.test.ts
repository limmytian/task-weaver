import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordLocalExecution, reconcileLocalExecution, observedLocalStop } from './local-execution-inventory.js'

test('a returned supervisor stops a fenced orphan and preserves divergent workspace provenance', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-returning-node-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home'); await mkdir(home); process.env.HOME = home
  const output = join(root, 'local-work')
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)`, output], { detached: true, stdio: 'ignore' })
  try {
    await new Promise<void>(resolve => child.once('spawn', resolve))
    recordLocalExecution({ requirementId: 'req', runId: 'old-run', daemonId: 'old-daemon', leaseGeneration: 1, pid: child.pid!, workspacePath: root })
    await assert.rejects(reconcileLocalExecution('req', 'new-run', async () => true), /authorized local execution/)
    let checks = 0
    for (let i = 0; i < 100; i++) { try { await stat(output); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
    await reconcileLocalExecution('req', 'new-run', async record => { checks++; assert.equal(record.runId, 'old-run'); return false })
    assert.equal(checks, 1)
    const old = JSON.parse(await readFile(join(home, '.task-weaver/execution-inventory/req-old-run-stale.json'), 'utf8'))
    assert.equal(old.workspacePath, root)
    assert.equal(observedLocalStop('req', 'old-run')?.workspacePath, root)
    const stopped = await readFile(output, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await readFile(output, 'utf8'), stopped)
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Already stopped. */ }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('stale managed descendants are stopped even after their group leader has exited', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-orphan-group-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home'); await mkdir(home); process.env.HOME = home
  const output = join(root, 'orphan-work')
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)`
  const source = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(output)}],{stdio:'ignore'});setInterval(()=>{},1000)`
  const leader = spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore' })
  try {
    await new Promise<void>(resolve => leader.once('spawn', resolve))
    recordLocalExecution({ requirementId: 'req', runId: 'old', daemonId: 'daemon', leaseGeneration: 1, pid: leader.pid!, workspacePath: root })
    for (let i = 0; i < 100; i++) { try { await stat(output); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
    const exited = new Promise<void>(resolve => leader.once('close', () => resolve()))
    leader.kill('SIGKILL'); await exited
    await reconcileLocalExecution('req', 'replacement', async () => false)
    const stopped = await readFile(output, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await readFile(output, 'utf8'), stopped)
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL') } catch { /* Already stopped. */ }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
