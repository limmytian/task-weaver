import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './async-command.js'

async function verifyManagedTree(startupDelayMs: number, parentResistsTerm: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'tw-process-tree-'))
  const file = join(root, 'child-heartbeat')
  const controller = new AbortController()
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  let output = ''
  // Readiness is emitted only after the TERM handler and first real write exist.
  const childSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setTimeout(()=>{fs.writeFileSync(process.argv[1],String(Date.now()));process.stdout.write('descendant-ready\\n');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)},${startupDelayMs})`
  const parent = `${parentResistsTerm ? "process.on('SIGTERM',()=>{});" : ''}const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childSource)},${JSON.stringify(file)}],{stdio:'inherit'});setInterval(()=>{},1000)`
  const run = runCommand(process.execPath, ['-e', parent], {
    signal: controller.signal,
    killGraceMs: 100,
    timeoutMs: 15_000,
    onOutput: ({ chunk }) => {
      output = (output + chunk).slice(-1024)
      if (output.includes('descendant-ready\n')) resolveReady()
    },
  })
  try {
    await Promise.race([
      ready,
      run.then(result => { throw new Error(`Managed tree exited before cancellation: ${JSON.stringify(result)}`) }),
    ])
    assert.ok(await readFile(file, 'utf8'), 'descendant performed a write before cancellation')
    controller.abort()
    const result = await run
    assert.equal(result.cancelled, true)
    assert.equal(result.timedOut, false)
    assert.equal(result.signal, parentResistsTerm ? 'SIGKILL' : 'SIGTERM', 'result signal describes the direct parent')
    const stopped = await readFile(file, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await readFile(file, 'utf8'), stopped, 'descendant stopped writing before replacement can start')
  } finally {
    // Failed readiness/assertions must still stop the tree before removing files.
    controller.abort()
    await run
    await rm(root, { recursive: true, force: true })
  }
}

test('cancel stops concurrent managed groups after acknowledged descendant readiness', {
  skip: process.platform === 'win32', timeout: 25_000, concurrency: true,
}, async t => {
  await Promise.all([0, 250, 500, 2100].map((delay, index) => {
    const parentResistsTerm = index % 2 === 1
    return t.test(`startup delay ${delay}ms, parent resists TERM: ${parentResistsTerm}`, () => verifyManagedTree(delay, parentResistsTerm))
  }))
})
