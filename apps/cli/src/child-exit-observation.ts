import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ChildExitObservation {
  runId: string
  daemonId: string
  leaseGeneration: number
  pid: number
  processIdentity: string
  status: number | null
  signal: NodeJS.Signals | null
}

/** Records only a directly observed child exit, not process-tree or external effects. */
export function writeChildExitObservation(record: ChildExitObservation, root = join(homedir(), '.task-weaver', 'child-exits')) {
  if (![record.runId, record.daemonId].every(value => /^[0-9a-f-]{36}$/i.test(value))
    || !Number.isSafeInteger(record.leaseGeneration) || record.leaseGeneration < 1
    || !Number.isSafeInteger(record.pid) || record.pid < 2
    || !record.processIdentity || record.processIdentity.length > 256
    || (record.status !== null && (!Number.isInteger(record.status) || record.status < 0 || record.status > 255))
    || (record.signal !== null && !/^SIG[A-Z0-9]{1,16}$/.test(record.signal))) throw new Error('Invalid child exit observation')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = join(root, `${randomUUID()}.json`)
  const temporary = `${target}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, kind: 'direct_child_exit', runId: record.runId, daemonId: record.daemonId, leaseGeneration: record.leaseGeneration, pid: record.pid, processIdentity: record.processIdentity, status: record.status, signal: record.signal, observedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* Nothing to clean up. */ }
    throw error
  }
  return target
}
