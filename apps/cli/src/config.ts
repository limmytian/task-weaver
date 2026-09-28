import { readFileSync, writeFileSync, mkdirSync } from 'fs'
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

const CONFIG_DIR = join(homedir(), '.config', 'tw')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export function loadConfig(): Config {
  const apiUrl = process.env.TW_API_URL
  const apiKey = process.env.TW_API_KEY
  const clientIdEnv = process.env.TW_CLIENT_ID
  const nodeIdEnv = process.env.TW_NODE_ID

  let fileConfig: Partial<Config> = {}
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    // no config file yet
  }

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
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(CONFIG_FILE, JSON.stringify({ ...fileConfig, clientId, nodeId }, null, 2) + '\n', 'utf-8')
    } catch {
      // ignore write failures
    }
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
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function configFilePath(): string {
  return CONFIG_FILE
}
