import { managedAgentListSchema, managedAgentProjectsSchema } from '@task-weaver/contracts'
import { Command } from 'commander'
import * as readline from 'readline/promises'
import { loadConfig, readStoredConfig, saveConfig, configFilePath } from '../config.js'
import { ApiError, request } from '../client.js'

export interface CliIdentity {
  actor: { id: string; type: 'human' | 'agent' }
  account: unknown
  session: unknown
}

export function validateApiUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('API URL must be an origin without credentials, a query or a path')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('API URL requires HTTPS except on loopback')
  }
  return url.origin
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = ''
    for await (const chunk of process.stdin) {
      value += chunk.toString()
      if (value.length > 4096) throw new Error('Credential input is too long')
    }
    return value.trim()
  }
  process.stderr.write('API key: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Login cancelled'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (character >= ' ') value += character
        if (value.length > 4096) return finish(new Error('Credential input is too long'))
      }
    }
    process.stdin.on('data', onData)
  })
}

export async function loginWithApiKey(apiUrl: string, apiKey: string): Promise<CliIdentity> {
  const origin = validateApiUrl(apiUrl)
  if (!/^tw_[0-9a-f]{64}$/.test(apiKey)) throw new Error('A subject-bound scoped API key is required')
  let identity: CliIdentity
  try {
    identity = await request<CliIdentity>('GET', '/api/v1/auth/me', undefined, { credential: { apiUrl: origin, apiKey } })
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(error.status, 'Credential verification failed')
    throw new Error('Credential verification unavailable')
  }
  if (!identity.actor?.id || !['human', 'agent'].includes(identity.actor.type)) throw new Error('Server did not return a verified identity')
  const current = loadConfig()
  const stored = readStoredConfig()
  saveConfig({ ...stored, clientId: stored.clientId ?? current.clientId, nodeId: stored.nodeId ?? current.nodeId, apiUrl: origin, apiKey })
  return identity
}

export function logoutLocal(): void {
  const stored = readStoredConfig()
  delete stored.apiKey
  saveConfig({ ...stored, apiUrl: stored.apiUrl ?? 'http://localhost:3001' })
}

function printIdentity(identity: CliIdentity, json?: boolean): void {
  console.log(json ? JSON.stringify(identity) : `Identity: ${identity.actor.type} ${identity.actor.id}`)
}

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('manage CLI authentication')
  const agents = auth.command('agents').description('inspect managed Agent identities and project permissions')
  agents.command('list').option('--status <status>', 'active|disabled|deleted', 'active')
    .option('--query <text>', 'search display names', '').option('--page <number>', 'page', '1')
    .option('--page-size <number>', 'page size (maximum 50)', '20').option('--json', 'output JSON')
    .action(async (opts) => {
      const { json: _json, ...input } = opts
      const parsed = managedAgentListSchema.parse(input)
      const query = new URLSearchParams(Object.entries(parsed).map(([key, value]) => [key, String(value)] as [string, string]))
      console.log(JSON.stringify(await request('GET', `/api/v1/auth/agents?${query}`)))
    })
  agents.command('get <id>').option('--json', 'output JSON').action(async (id: string) => {
    const { actorId } = managedAgentProjectsSchema.parse({ actorId: id })
    console.log(JSON.stringify(await request('GET', `/api/v1/auth/agents/${actorId}`)))
  })
  agents.command('projects <id>').option('--view <view>', 'memberships|available', 'memberships')
    .option('--query <text>', 'search authorized project names', '').option('--page <number>', 'page', '1')
    .option('--page-size <number>', 'page size (maximum 50)', '20').option('--json', 'output JSON')
    .action(async (id: string, opts) => {
      const { json: _json, ...input } = opts
      const { actorId, ...parsed } = managedAgentProjectsSchema.parse({ ...input, actorId: id })
      const query = new URLSearchParams(Object.entries(parsed).map(([key, value]) => [key, String(value)] as [string, string]))
      console.log(JSON.stringify(await request('GET', `/api/v1/auth/agents/${actorId}/projects?${query}`)))
    })
  auth.command('setup').description('configure API URL and a verified scoped API key').action(async () => {
    const current = loadConfig()
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let apiUrl: string
    try { apiUrl = (await rl.question(`API URL [${current.apiUrl}]: `)).trim() || current.apiUrl }
    finally { rl.close() }
    printIdentity(await loginWithApiKey(apiUrl, await readSecret()))
    console.log(`Saved to ${configFilePath()}`)
  })
  auth.command('login').description('verify and save a scoped API key from hidden input or stdin')
    .option('--api-url <url>', 'API origin').option('--json', 'output verified identity')
    .action(async (opts: { apiUrl?: string; json?: boolean }) => {
      printIdentity(await loginWithApiKey(opts.apiUrl ?? loadConfig().apiUrl, await readSecret()), opts.json)
      if (process.env.TW_API_KEY !== undefined) console.error('TW_API_KEY overrides the saved credential until it is unset.')
    })
  auth.command('logout').description('remove the local key; revoke shared keys separately on the server').action(() => {
    logoutLocal()
    console.log('Local credential removed.')
    if (process.env.TW_API_KEY !== undefined) console.error('TW_API_KEY remains active until it is unset.')
  })
  auth.command('whoami').description('query the verified credential identity').option('--json', 'output identity JSON')
    .action(async (opts: { json?: boolean }) => printIdentity(await request<CliIdentity>('GET', '/api/v1/auth/me'), opts.json))
  auth.command('status').description('check reachability and verified identity independently').option('--json', 'output status JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig()
      const result: { apiUrl: string; credential: string; reachability: string; authentication: string; actor?: CliIdentity['actor']; permission: string } = {
        apiUrl: validateApiUrl(config.apiUrl), credential: config.apiKey ? '(configured)' : '(not set)', reachability: 'unreachable', authentication: 'unverified', permission: 'resource-specific checks required',
      }
      try { await request('GET', '/health'); result.reachability = 'reachable' } catch { /* Independent reachability probe. */ }
      try {
        const identity = await request<CliIdentity>('GET', '/api/v1/auth/me')
        result.authentication = 'authenticated'
        result.reachability = 'reachable'
        result.actor = identity.actor
      } catch (error) {
        if (error instanceof ApiError) {
          result.reachability = 'reachable'
          result.authentication = error.status === 401 ? 'invalid or missing credential' : error.status === 403 ? 'permission denied' : 'identity check failed'
        } else result.authentication = 'identity check unavailable'
      }
      if (opts.json) console.log(JSON.stringify(result))
      else for (const [key, value] of Object.entries(result)) console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    })
}
