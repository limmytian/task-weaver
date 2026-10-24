import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface LinuxProcessState { state: string; groupId: number; startTime: string }

/** The command name can contain spaces and parentheses; fields start after its final closing parenthesis. */
export function parseLinuxProcessStat(value: string): LinuxProcessState {
  const end = value.lastIndexOf(')')
  const fields = value.slice(end + 1).trim().split(/\s+/)
  if (end < 0 || fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]!)
    || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[19]!)) throw new Error('Invalid Linux process state')
  return { state: fields[0]!, groupId: Number(fields[2]), startTime: fields[19]! }
}

function inspect(pid: number, root: string): LinuxProcessState | null {
  try { return parseLinuxProcessStat(readFileSync(join(root, String(pid), 'stat'), 'utf8')) }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** Boot identity and kernel start ticks distinguish reused PIDs, including after a host reboot. */
export function linuxProcessIdentity(pid: number, root = '/proc'): string {
  const process = inspect(pid, root)
  if (!process) return ''
  const boot = readFileSync(join(root, 'sys/kernel/random/boot_id'), 'utf8').trim()
  if (!/^[0-9a-f-]{36}$/i.test(boot)) throw new Error('Linux boot identity is unavailable')
  return `linux:${boot}:${process.startTime}`
}

/** Procfs works on minimal Linux hosts without requiring GNU/procps ps options. */
export function linuxActiveGroupMembers(groupId: number, root = '/proc'): number {
  let count = 0
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue
    const process = inspect(Number(name), root)
    if (process?.groupId === groupId && !['Z', 'X', 'x'].includes(process.state)) count++
  }
  return count
}
