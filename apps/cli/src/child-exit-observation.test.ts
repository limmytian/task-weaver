import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { runCommand } from './async-command.js'
import { recordLocalExecution, reconcileLocalExecution } from './local-execution-inventory.js'
import { writeChildExitObservation } from './child-exit-observation.js'

test('direct child exits are persisted with the recorded identity, including termination', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-child-exit-'))
  const oldHome = process.env.HOME; process.env.HOME = root
  const runId = randomUUID(), daemonId = randomUUID()
  try {
    for (const terminate of [false, true]) {
      let identity = '', pid = 0
      const controller = new AbortController()
      await runCommand(process.execPath, ['-e', terminate ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>process.exit(7),100)'], {
        signal: controller.signal, killGraceMs: 100,
        onSpawn: childPid => { pid = childPid!; identity = recordLocalExecution({ requirementId: 'req', runId, daemonId, leaseGeneration: 3, pid, workspacePath: root }); if (terminate) controller.abort() },
        onExit: (status, signal) => writeChildExitObservation({ runId, daemonId, leaseGeneration: 3, pid, processIdentity: identity, status, signal }, join(root, 'exits')),
      })
      const files = await readdir(join(root, 'exits'))
      const records = await Promise.all(files.map(async file => JSON.parse(await readFile(join(root, 'exits', file), 'utf8'))))
      const record = records.find(value => value.pid === pid)
      assert.equal(record.kind, 'direct_child_exit'); assert.equal(record.processIdentity, identity)
      assert.equal(record.runId, runId); assert.equal(record.daemonId, daemonId); assert.equal(record.leaseGeneration, 3)
      assert.equal(record.status, terminate ? null : 7); assert.equal(record.signal, terminate ? 'SIGTERM' : null)
      assert.deepEqual(Object.keys(record).sort(), ['daemonId', 'kind', 'leaseGeneration', 'observedAt', 'pid', 'processIdentity', 'runId', 'signal', 'status', 'version'].sort())
    }
    let exited = false
    await runCommand(join(root, 'missing-command'), [], { onExit: () => { exited = true } })
    assert.equal(exited, false)
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(root, { recursive: true, force: true }) }
})

test('restart reconciliation and identity mismatch do not create exit observations', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-child-restart-'))
  const oldHome = process.env.HOME; process.env.HOME = root
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  try {
    await new Promise<void>(resolve => child.once('spawn', resolve))
    recordLocalExecution({ requirementId: 'req', runId: 'old', daemonId: 'daemon', leaseGeneration: 1, pid: child.pid!, workspacePath: root })
    const path = join(root, '.task-weaver/execution-inventory/req.json')
    const record = JSON.parse(await readFile(path, 'utf8')); record.processIdentity = 'different-identity'
    await writeFile(path, JSON.stringify(record))
    await assert.rejects(reconcileLocalExecution('req', 'new', async () => false), /identity changed/)
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed
    await reconcileLocalExecution('req', 'new', async () => false)
    await assert.rejects(readdir(join(root, '.task-weaver/child-exits')), { code: 'ENOENT' })
  } finally { child.kill('SIGKILL'); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(root, { recursive: true, force: true }) }
})
