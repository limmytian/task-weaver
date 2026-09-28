import { Command } from 'commander'
import * as readline from 'readline/promises'
import { del, get, patch, post } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'
import { loadConfig, saveConfig, type RepositoryCredentialProfile } from '../config.js'
import { resolveRepositoryCredential } from '../repository-credentials.js'

type RepositoryList = {
  items: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

function listPath(opts: Record<string, unknown>, query?: string): string {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (opts.provider) params.set('provider', String(opts.provider))
  if (opts.host) params.set('host', String(opts.host))
  if (opts.status) params.set('status', String(opts.status))
  if (opts.visibility) params.set('visibility', String(opts.visibility))
  if (opts.tags) params.set('tags', String(opts.tags))
  if (opts.sort) params.set('sort', String(opts.sort))
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  const suffix = params.toString()
  return `/api/v1/repositories${suffix ? `?${suffix}` : ''}`
}

function printRepositories(data: RepositoryList): void {
  printTable(data.items, ['id', 'canonicalKey', 'provider', 'status', 'visibility', 'usageCount'])
  console.log(`Page ${data.page}/${Math.max(data.pageCount, 1)} · ${data.total} repositories`)
}

function addListOptions(command: Command): Command {
  return command
    .option('--provider <provider>', 'filter by provider')
    .option('--host <host>', 'filter by normalized host')
    .option('--status <status>', 'active|archived')
    .option('--visibility <visibility>', 'instance|restricted|private')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--sort <sort>', 'relevance|recently-used|usage|name|updated', 'relevance')
    .option('--page <n>', 'page number', '1')
    .option('--page-size <n>', 'page size', '25')
    .option('--json', 'output raw JSON')
}

export function registerRepositories(program: Command): void {
  const repo = program.command('repo').description('discover and manage repositories')

  addListOptions(repo.command('list').description('list and filter visible repositories'))
    .option('--query <query>', 'search repository identity and metadata')
    .action(async (opts) => {
      const data = await get<RepositoryList>(listPath(opts, opts.query))
      if (opts.json) return printJson(data)
      printRepositories(data)
    })

  addListOptions(repo.command('search <query>').description('search visible repositories'))
    .action(async (query, opts) => {
      const data = await get<RepositoryList>(listPath(opts, query))
      if (opts.json) return printJson(data)
      printRepositories(data)
    })

  repo.command('get <id>')
    .description('get repository identity, usage, delivery, and scoped readiness')
    .option('--node <nodeId>', 'daemon node used for readiness evaluation')
    .option('--operation <operation>', 'read|push|forge', 'read')
    .option('--transport <transport>', 'ssh|https')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams({ operation: opts.operation })
      if (opts.node) params.set('nodeId', opts.node)
      if (opts.transport) params.set('transport', opts.transport)
      const data = await get(`/api/v1/repositories/${id}?${params}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('create')
    .description('create an instance repository catalog entry')
    .requiredOption('--host <host>', 'normalized Git host')
    .requiredOption('--namespace <namespace>', 'repository owner or namespace')
    .requiredOption('--name <name>', 'repository name')
    .option('--display-name <name>', 'human-readable display name')
    .option('--description <description>', 'repository description')
    .option('--provider <provider>', 'provider adapter identifier', 'generic')
    .option('--provider-id <id>', 'stable provider external ID')
    .option('--web-url <url>', 'non-secret Web URL')
    .option('--https-url <url>', 'non-secret HTTPS clone URL')
    .option('--ssh-url <url>', 'non-secret SSH clone URL')
    .option('--default-branch <branch>', 'default branch')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--visibility <visibility>', 'instance|restricted|private', 'instance')
    .option('--owner-id <id>', 'owner for restricted/private metadata')
    .option('--owner-type <type>', 'human|agent')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post('/api/v1/repositories', {
        displayName: opts.displayName,
        description: opts.description,
        provider: opts.provider,
        providerExternalId: opts.providerId,
        host: opts.host,
        namespace: opts.namespace,
        name: opts.name,
        webUrl: opts.webUrl,
        httpsCloneUrl: opts.httpsUrl,
        sshCloneUrl: opts.sshUrl,
        defaultBranch: opts.defaultBranch,
        tags: opts.tags ? String(opts.tags).split(',').map((tag) => tag.trim()).filter(Boolean) : undefined,
        visibility: opts.visibility,
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('update <id>')
    .description('update repository metadata')
    .option('--display-name <name>', 'human-readable display name')
    .option('--description <description>', 'repository description')
    .option('--provider <provider>', 'provider adapter identifier')
    .option('--provider-id <id>', 'stable provider external ID')
    .option('--host <host>', 'normalized Git host')
    .option('--namespace <namespace>', 'repository owner or namespace')
    .option('--name <name>', 'repository name')
    .option('--web-url <url>', 'non-secret Web URL')
    .option('--https-url <url>', 'non-secret HTTPS clone URL')
    .option('--ssh-url <url>', 'non-secret SSH clone URL')
    .option('--default-branch <branch>', 'default branch')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--visibility <visibility>', 'instance|restricted|private')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      const fields: Array<[string, string]> = [
        ['displayName', 'displayName'], ['description', 'description'], ['provider', 'provider'],
        ['providerId', 'providerExternalId'], ['host', 'host'], ['namespace', 'namespace'],
        ['name', 'name'], ['webUrl', 'webUrl'], ['httpsUrl', 'httpsCloneUrl'],
        ['sshUrl', 'sshCloneUrl'], ['defaultBranch', 'defaultBranch'], ['visibility', 'visibility'],
      ]
      for (const [option, field] of fields) if (opts[option] !== undefined) body[field] = opts[option]
      if (opts.tags !== undefined) body.tags = String(opts.tags).split(',').map((tag) => tag.trim()).filter(Boolean)
      const data = await patch(`/api/v1/repositories/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  repo.command('archive <id>')
    .description('archive a repository after downstream-impact checks')
    .option('--force', 'skip confirmation prompt')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      if (!opts.force) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Archive repository ${id}? Active requirement links will block this action. [y/N] `)
        rl.close()
        if (answer.trim().toLowerCase() !== 'y') return console.log('Aborted.')
      }
      const data = await del(`/api/v1/repositories/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  const credential = repo.command('credential').description('manage non-secret local credential profile bindings')

  credential.command('list')
    .option('--json', 'output raw JSON')
    .action((opts) => {
      const profiles = Object.entries(loadConfig().repositoryCredentialProfiles ?? {}).map(([name, profile]) => ({
        name,
        kind: profile.kind,
        host: profile.host,
        provider: profile.provider,
        transport: profile.transport,
        allowedOperations: profile.allowedOperations,
        consent: profile.consent,
        status: profile.status,
        revision: profile.revision,
      }))
      if (opts.json) return printJson({ items: profiles })
      printTable(profiles, ['name', 'kind', 'host', 'transport', 'allowedOperations', 'consent', 'status', 'revision'])
    })

  credential.command('set <name>')
    .description('create or rotate a local non-secret credential profile reference')
    .requiredOption('--kind <kind>', 'ssh-agent|git-helper|system-keychain')
    .requiredOption('--host <host>', 'normalized Git host')
    .requiredOption('--transport <transport>', 'ssh|https')
    .option('--provider <provider>', 'provider adapter identifier')
    .option('--operations <operations>', 'comma-separated read,push,forge', 'read,push')
    .option('--actor <actorId>', 'restrict to an actor ID')
    .option('--node <nodeId>', 'restrict to a daemon node; defaults to this node')
    .option('--shared', 'record explicit node-shared consent')
    .option('--known-hosts <path>', 'node-managed known_hosts path for SSH')
    .option('--json', 'output raw JSON')
    .action((name, opts) => {
      const config = loadConfig()
      const current = config.repositoryCredentialProfiles?.[name]
      const kinds = ['ssh-agent', 'git-helper', 'system-keychain'] as const
      const transports = ['ssh', 'https'] as const
      const validOperations = ['read', 'push', 'forge'] as const
      if (!kinds.includes(opts.kind)) throw new Error(`Unsupported credential profile kind: ${opts.kind}`)
      if (!transports.includes(opts.transport)) throw new Error(`Unsupported repository transport: ${opts.transport}`)
      const allowedOperations = String(opts.operations).split(',').map((item) => item.trim()).filter(Boolean)
      if (allowedOperations.length === 0 || allowedOperations.some(
        (operation) => !validOperations.includes(operation as (typeof validOperations)[number]),
      )) {
        throw new Error('Credential operations must be a non-empty subset of read,push,forge')
      }
      if (opts.kind === 'ssh-agent' && opts.transport !== 'ssh') {
        throw new Error('ssh-agent profiles require the ssh transport')
      }
      if (opts.kind !== 'ssh-agent' && opts.transport !== 'https') {
        throw new Error(`${opts.kind} profiles require the https transport`)
      }
      const profile: RepositoryCredentialProfile = {
        kind: opts.kind,
        host: String(opts.host).trim().toLowerCase(),
        provider: opts.provider,
        transport: opts.transport,
        allowedOperations: allowedOperations as RepositoryCredentialProfile['allowedOperations'],
        actorId: opts.actor,
        nodeId: opts.node ?? config.nodeId,
        consent: opts.shared ? 'node-shared' : 'personal',
        status: 'active',
        revision: (current?.revision ?? 0) + 1,
        knownHostsPath: opts.knownHosts,
      }
      config.repositoryCredentialProfiles = { ...config.repositoryCredentialProfiles, [name]: profile }
      saveConfig(config)
      const safe = { name, ...profile, actorId: profile.actorId ? '[scoped]' : undefined, nodeId: profile.nodeId ? '[scoped]' : undefined }
      if (opts.json) return printJson(safe)
      printKv(safe)
    })

  credential.command('revoke <name>')
    .description('monotonically revoke a local credential profile revision')
    .option('--json', 'output raw JSON')
    .action((name, opts) => {
      const config = loadConfig()
      const profile = config.repositoryCredentialProfiles?.[name]
      if (!profile) throw new Error(`Credential profile not found: ${name}`)
      const revoked: RepositoryCredentialProfile = { ...profile, status: 'revoked', revision: profile.revision + 1 }
      config.repositoryCredentialProfiles = { ...config.repositoryCredentialProfiles, [name]: revoked }
      saveConfig(config)
      const safe = { name, status: revoked.status, revision: revoked.revision }
      if (opts.json) return printJson(safe)
      printKv(safe)
    })

  credential.command('readiness <repositoryId>')
    .description('evaluate actor/node-scoped local Git credential readiness without using a credential')
    .option('--operation <operation>', 'read|push|forge', 'read')
    .option('--transport <transport>', 'ssh|https')
    .option('--json', 'output raw JSON')
    .action(async (repositoryId, opts) => {
      const repository = await get<any>(`/api/v1/repositories/${repositoryId}`)
      const result = resolveRepositoryCredential(loadConfig(), repository, opts.operation, opts.transport)
      const safe = {
        state: result.state,
        reasonCode: result.reasonCode,
        transport: result.transport,
        operation: result.operation,
        checkedAt: result.checkedAt,
        policyRevision: result.policyRevision,
        profileRevision: result.profileRevision,
      }
      if (opts.json) return printJson(safe)
      printKv(safe)
    })
}
