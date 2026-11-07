import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function location(nodeId: string, codexHome: string) {
  const key = createHash('sha256').update(`${nodeId}\0${codexHome}`).digest('hex')
  const directory = join(homedir(), '.task-weaver', 'worker-cooldowns')
  return { directory, path: join(directory, `${key}.json`) }
}

export async function readThinCooldown(nodeId: string, codexHome: string, now = Date.now()) {
  const { directory, path } = location(nodeId, codexHome)
  try {
    if ((await lstat(directory)).isSymbolicLink() || (await lstat(path)).isSymbolicLink()) throw new Error('Unsafe worker cooldown path')
    const info = await lstat(path)
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid worker cooldown')
    const value = JSON.parse(await readFile(path, 'utf8')) as { until?: unknown }
    if (typeof value.until !== 'number' || !Number.isSafeInteger(value.until)) throw new Error('Invalid worker cooldown')
    return value.until > now ? new Date(value.until).toISOString() : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Unable to read worker cooldown safely')
  }
}

export async function writeThinCooldown(nodeId: string, codexHome: string, retryAt: string | null, now = Date.now()) {
  const { directory, path } = location(nodeId, codexHome)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe worker cooldown path')
  await chmod(directory, 0o700)
  const current = await readThinCooldown(nodeId, codexHome, now)
  const parsed = retryAt ? Date.parse(retryAt) : NaN
  const until = Math.max(current ? Date.parse(current) : 0, now + 15 * 60000, Number.isFinite(parsed) ? Math.min(parsed, now + 24 * 3600000) : 0)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ until }) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return new Date(until).toISOString()
}
