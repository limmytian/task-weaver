import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync, lstatSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface Config {
  apiUrl: string
  apiKey?: string
  clientId?: string
  nodeId?: string
  actorId?: string
  daemonInstanceIds?: Partial<Record<'executor' | 'reviewer' | 'merger', string>>
  repositoryCredentialProfiles?: Record<string, RepositoryCredentialProfile>
}

export interface RepositoryCredentialProfile {
  kind: 'ssh-agent' | 'git-helper' | 'system-keychain'
  host: string
  provider?: string
  transport: 'ssh' | 'https'
  allowedOperations: Array<'read' | 'push' | 'forge'>
  actorId?: string
  nodeId?: string
  consent: 'personal' | 'node-shared'
  status: 'active' | 'revoked'
  revision: number
  knownHostsPath?: string
}

function configDirectory(): string {
  return process.env.TW_CONFIG_DIR ?? join(homedir(), '.config', 'tw')
}

export function readStoredConfig(): Partial<Config> {
  try {
    if (lstatSync(configDirectory()).isSymbolicLink() || lstatSync(configFilePath()).isSymbolicLink()) throw new Error('Unsafe CLI configuration path')
    chmodSync(configDirectory(), 0o700)
    chmodSync(configFilePath(), 0o600)
    const value: unknown = JSON.parse(readFileSync(configFilePath(), 'utf-8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CLI configuration')
    return value as Partial<Config>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Unable to read CLI configuration')
  }
}

export function loadConfig(): Config {
  const apiUrl = process.env.TW_API_URL
  const apiKey = process.env.TW_API_KEY
  const clientIdEnv = process.env.TW_CLIENT_ID
  const nodeIdEnv = process.env.TW_NODE_ID

  const fileConfig = readStoredConfig()

  let dirty = false

  let clientId = clientIdEnv ?? fileConfig.clientId
  if (!clientId) {
    clientId = `cli-${randomUUID()}`
    dirty = true
  }

  let nodeId = nodeIdEnv ?? fileConfig.nodeId
  if (!nodeId) {
    nodeId = `node-${randomUUID()}`
    dirty = true
  }

  if (dirty) {
    saveConfig({ ...fileConfig, apiUrl: fileConfig.apiUrl ?? 'http://localhost:3001', clientId, nodeId })
  }

  return {
    apiUrl: apiUrl ?? fileConfig.apiUrl ?? 'http://localhost:3001',
    apiKey: apiKey ?? fileConfig.apiKey,
    clientId,
    nodeId,
    actorId: fileConfig.actorId,
    daemonInstanceIds: fileConfig.daemonInstanceIds,
    repositoryCredentialProfiles: fileConfig.repositoryCredentialProfiles,
  }
}

export function saveConfig(config: Config): void {
  const directory = configDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe CLI configuration path')
  chmodSync(directory, 0o700)
  const temporary = join(directory, `.config-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, configFilePath())
    chmodSync(configFilePath(), 0o600)
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export function configFilePath(): string {
  return join(configDirectory(), 'config.json')
}
