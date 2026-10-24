import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxActiveGroupMembers, linuxProcessIdentity, parseLinuxProcessStat } from './linux-process-state.js'

const boot = '00000000-0000-4000-8000-000000000001'
const stat = (pid: number, group: number, state: string, ticks: string) => `${pid} (agent (with) spaces)) ${[state, '1', String(group), ...Array(16).fill('0'), ticks].join(' ')}`

test('Linux process identity survives command-name delimiters and distinguishes PID reuse and reboot', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-proc-'))
  try {
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true })
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), boot)
    mkdirSync(join(root, '123'))
    writeFileSync(join(root, '123/stat'), stat(123, 123, 'S', '9007199254740993'))
    assert.deepEqual(parseLinuxProcessStat(stat(123, 123, 'S', '9007199254740993')), { state: 'S', groupId: 123, startTime: '9007199254740993' })
    const first = linuxProcessIdentity(123, root)
    writeFileSync(join(root, '123/stat'), stat(123, 123, 'S', '9007199254740994'))
    assert.notEqual(linuxProcessIdentity(123, root), first)
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), '00000000-0000-4000-8000-000000000002')
    writeFileSync(join(root, '123/stat'), stat(123, 123, 'S', '9007199254740993'))
    assert.notEqual(linuxProcessIdentity(123, root), first)
    assert.equal(linuxProcessIdentity(999, root), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Linux group inspection excludes dead processes and fails closed on unreadable state', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-proc-group-'))
  try {
    for (const [pid, group, state] of [[1, 1, 'S'], [123, 123, 'Z'], [124, 123, 'S'], [125, 123, 'X']] as const) {
      mkdirSync(join(root, String(pid)))
      writeFileSync(join(root, String(pid), 'stat'), stat(pid, group, state, '1'))
    }
    mkdirSync(join(root, '126')) // A process that exited while /proc was enumerated.
    assert.equal(linuxActiveGroupMembers(123, root), 1)
    mkdirSync(join(root, '126/stat'))
    assert.throws(() => linuxActiveGroupMembers(123, root))
    assert.throws(() => parseLinuxProcessStat('invalid'), /Invalid Linux process state/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
