import assert from 'node:assert/strict'
import test from 'node:test'
import { runCommand } from './async-command.js'

test('runCommand captures structured output and streams redacted events', async () => {
  const events: string[] = []
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("token=secret\\n"); process.stderr.write("warning\\n")'], {
    redact: (value) => value.replaceAll('secret', '[redacted]'),
    onOutput: ({ stream, chunk }) => events.push(`${stream}:${chunk}`),
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'token=[redacted]')
  assert.equal(result.stderr, 'warning')
  assert.ok(events.some((event) => event.includes('[redacted]')))
  assert.equal(result.timedOut, false)
  assert.equal(result.cancelled, false)
})

test('runCommand bounds captured output while continuing to drain the child', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(4096))'], {
    maxOutputBytes: 128,
  })

  assert.equal(result.ok, true)
  assert.equal(Buffer.byteLength(result.stdout), 128)
  assert.equal(result.outputTruncated, true)
})

test('runCommand terminates commands that exceed their deadline', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 25,
    killGraceMs: 25,
  })

  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.signal ?? '', /SIGTERM|SIGKILL/)
})

test('runCommand responds to AbortSignal cancellation', async () => {
  const controller = new AbortController()
  const running = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    killGraceMs: 25,
  })
  controller.abort()
  const result = await running

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
})

test('runCommand escalates cancellation from TERM to KILL after the grace period', async (context) => {
  if (process.platform === 'win32') return context.skip('POSIX signal escalation test')
  const controller = new AbortController()
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  const running = runCommand(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
    {
      signal: controller.signal,
      killGraceMs: 25,
      onOutput: ({ chunk }) => { if (chunk.includes('ready')) resolveReady() },
    },
  )
  await ready
  controller.abort()
  const result = await running

  assert.equal(result.cancelled, true)
  assert.equal(result.signal, 'SIGKILL')
})

test('independent commands overlap without blocking the control loop', async () => {
  const controllers = [new AbortController(), new AbortController()]
  let readyCount = 0
  let resolveReady!: () => void
  const bothReady = new Promise<void>((resolve) => { resolveReady = resolve })
  let controlLoopTicks = 0
  const heartbeat = setInterval(() => { controlLoopTicks += 1 }, 5)
  const start = (index: number) => runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
    {
      signal: controllers[index]!.signal,
      onOutput: ({ chunk }) => {
        if (!chunk.includes('ready')) return
        readyCount += 1
        if (readyCount === 2) resolveReady()
      },
    },
  )

  const commands = [start(0), start(1)]
  await bothReady
  await new Promise((resolve) => setTimeout(resolve, 25))
  controllers.forEach((controller) => controller.abort())
  const results = await Promise.all(commands)
  clearInterval(heartbeat)

  assert.equal(readyCount, 2)
  assert.ok(controlLoopTicks > 0)
  assert.ok(results.every((result) => result.cancelled))
})
