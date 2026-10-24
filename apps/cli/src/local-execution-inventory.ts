import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linuxActiveGroupMembers, linuxProcessIdentity } from './linux-process-state.js'

export interface LocalExecutionRecord {
  requirementId: string
  daemonId: string
  runId: string
  leaseGeneration: number
  pid: number
  processIdentity: string
  workspacePath: string
}
const inventoryRoot = () => join(homedir(), '.task-weaver', 'execution-inventory')
const inventoryPath = (id: string) => join(inventoryRoot(), `${id}.json`)
function identity(pid: number) {
  if (process.platform === 'linux') return linuxProcessIdentity(pid)
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2500 })
  return result.status === 0 ? result.stdout.trim() : ''
}

function activeGroupMembers(groupId: number) {
  if (process.platform === 'linux') return linuxActiveGroupMembers(groupId)
  const result = spawnSync('ps', ['-eo', 'pgid=,pid=,stat='], { encoding: 'utf8', timeout: 2500 })
  if (result.status !== 0) throw new Error('Managed process group could not be inspected')
  return result.stdout.split('\n').filter(line => {
    const [group, , state] = line.trim().split(/\s+/)
    return Number(group) === groupId && state && !state.startsWith('Z')
  }).length
}

export function recordLocalExecution(record: Omit<LocalExecutionRecord, 'processIdentity'>) {
  const processIdentity = identity(record.pid)
  if (!processIdentity) throw new Error('Managed process identity could not be recorded')
  mkdirSync(inventoryRoot(), { recursive: true, mode: 0o700 })
  const target = inventoryPath(record.requirementId)
  writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify({ ...record, processIdentity }), { mode: 0o600 })
  renameSync(`${target}.${process.pid}.tmp`, target)
}
export async function clearLocalExecution(requirementId: string, runId: string) {
  const path = inventoryPath(requirementId)
  if (!existsSync(path)) return
  const record = JSON.parse(readFileSync(path, 'utf8')) as LocalExecutionRecord
  if (record.runId !== runId) return
  for (let attempt = 0; attempt < 50 && activeGroupMembers(record.pid) > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  if (activeGroupMembers(record.pid) > 0) throw new Error('Managed execution still has active descendants')
  writeFileSync(join(inventoryRoot(), `${requirementId}-${runId}-stopped.json`), JSON.stringify({ ...record, observedStoppedAt: new Date().toISOString() }), { mode: 0o600 })
  unlinkSync(path)
}
export function localExecutionInventory(): LocalExecutionRecord[] {
  if (!existsSync(inventoryRoot())) return []
  return readdirSync(inventoryRoot()).filter(name => name.endsWith('.json') && !name.endsWith('-stale.json') && !name.endsWith('-stopped.json')).map(name => JSON.parse(readFileSync(join(inventoryRoot(), name), 'utf8')) as LocalExecutionRecord)
}

export function observedLocalStop(requirementId: string, runId: string): LocalExecutionRecord | null {
  for (const suffix of ['stopped', 'stale']) {
    const path = join(inventoryRoot(), `${requirementId}-${runId}-${suffix}.json`)
    if (!existsSync(path)) continue
    const record = JSON.parse(readFileSync(path, 'utf8')) as LocalExecutionRecord
    if (record.runId === runId && record.requirementId === requirementId && activeGroupMembers(record.pid) === 0) return record
  }
  return null
}

/** A returned node checks platform authority before touching a prior managed process or its files. */
export async function reconcileLocalExecution(requirementId: string, runId: string, isAuthorized: (record: LocalExecutionRecord) => Promise<boolean>) {
  const path = inventoryPath(requirementId)
  if (!existsSync(path)) return
  const record = JSON.parse(readFileSync(path, 'utf8')) as LocalExecutionRecord
  if (!Number.isInteger(record.pid) || record.pid <= 1 || record.requirementId !== requirementId) throw new Error('Local execution inventory needs manual inspection')
  const currentIdentity = identity(record.pid)
  if (currentIdentity && currentIdentity !== record.processIdentity) throw new Error('Process identity changed; refuse to signal a reused PID')
  if (currentIdentity || activeGroupMembers(record.pid) > 0) {
    if (record.runId === runId || await isAuthorized(record)) throw new Error('A prior authorized local execution is still active')
    if (process.platform === 'win32') throw new Error('Stale process-tree termination needs a supported local supervisor')
    try { process.kill(-record.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
    try { process.kill(-record.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    for (let attempt = 0; attempt < 50 && activeGroupMembers(record.pid) > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    if (activeGroupMembers(record.pid) > 0) throw new Error('Stale managed execution has not confirmed exit; workspace remains blocked')
  }
  // Preserve provenance and divergent files. Nothing is merged or published here.
  renameSync(path, join(inventoryRoot(), `${requirementId}-${record.runId}-stale.json`))
}
