import { Command } from 'commander'
import { get, patch, post } from '../client.js'
import { printJson, printKv, printTable } from '../output.js'

function profileBody(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [option, key] of [
    ['name', 'name'], ['scope', 'scope'], ['project', 'projectId'],
    ['owner', 'personalOwnerId'], ['ownerType', 'personalOwnerType'],
    ['baseUrl', 'baseUrl'], ['model', 'model'], ['dimensions', 'dimensions'],
    ['secretRef', 'secretRef'], ['timeoutMs', 'timeoutMs'], ['batchSize', 'batchSize'],
    ['maxConcurrency', 'maxConcurrency'], ['chunkSize', 'chunkSize'],
    ['chunkOverlap', 'chunkOverlap'], ['chunkingVersion', 'chunkingVersion'],
    ['retentionGenerations', 'retentionGenerations'],
  ] as const) {
    const value = opts[option]
    if (value !== undefined) body[key] = ['dimensions', 'timeoutMs', 'batchSize', 'maxConcurrency', 'chunkSize', 'chunkOverlap', 'retentionGenerations'].includes(key)
      ? Number(value)
      : value
  }
  if (opts.enabled !== undefined) body.enabled = opts.enabled
  if (opts.expectedVersion !== undefined) body.expectedVersion = Number(opts.expectedVersion)
  return body
}

export function registerEmbeddings(program: Command): void {
  const embedding = program.command('embedding').description('manage embedding profiles, indexes, and retrieval controls')

  embedding.command('list')
    .option('--project <id>', 'include project-scoped profiles')
    .option('--include-personal', 'include the current actor personal profiles')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.includePersonal) params.set('includePersonal', 'true')
      const suffix = params.toString() ? `?${params}` : ''
      const data = await get<{ items: Record<string, unknown>[] }>(`/api/v1/embeddings/profiles${suffix}`)
      if (opts.json) return printJson(data)
      printTable(data.items, ['id', 'name', 'scope', 'status', 'model', 'dimensions'])
    })

  embedding.command('get <id>').option('--json', 'output raw JSON').action(async (id, opts) => {
    const data = await get<Record<string, unknown>>(`/api/v1/embeddings/profiles/${id}`)
    if (opts.json) return printJson(data)
    printKv(data)
  })

  embedding.command('create')
    .requiredOption('--name <name>')
    .requiredOption('--scope <scope>', 'global|project|personal')
    .requiredOption('--base-url <url>')
    .requiredOption('--model <model>')
    .requiredOption('--dimensions <n>')
    .requiredOption('--secret-ref <ref>')
    .option('--project <id>')
    .option('--owner <id>')
    .option('--owner-type <type>', 'human|agent')
    .option('--timeout-ms <n>')
    .option('--batch-size <n>')
    .option('--max-concurrency <n>')
    .option('--chunk-size <n>')
    .option('--chunk-overlap <n>')
    .option('--chunking-version <version>')
    .option('--retention-generations <n>')
    .option('--enabled', 'enable after creation (normally validate explicitly)')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await post<Record<string, unknown>>('/api/v1/embeddings/profiles', profileBody({ ...opts, enabled: false }))
      const result = opts.enabled && typeof data.id === 'string'
        ? await post<Record<string, unknown>>(`/api/v1/embeddings/profiles/${data.id}/enable`, {})
        : data
      if (opts.json) return printJson(result)
      printKv(result)
    })

  embedding.command('update <id>')
    .option('--name <name>').option('--base-url <url>').option('--model <model>')
    .option('--dimensions <n>').option('--secret-ref <ref>').option('--timeout-ms <n>')
    .option('--batch-size <n>').option('--max-concurrency <n>').option('--chunk-size <n>')
    .option('--chunk-overlap <n>').option('--chunking-version <version>').option('--retention-generations <n>')
    .option('--expected-version <n>').option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await patch<Record<string, unknown>>(`/api/v1/embeddings/profiles/${id}`, profileBody(opts))
      if (opts.json) return printJson(data)
      printKv(data)
    })

  for (const [name, path, description] of [
    ['test', 'test', 'validate provider credentials and capabilities'],
    ['enable', 'enable', 'validate and enable a profile'],
    ['disable', 'disable', 'disable a profile without deleting data'],
    ['preview', 'preview', 'show safe rebuild coverage preview'],
  ] as const) {
    embedding.command(`${name} <id>`).description(description).option('--json', 'output raw JSON').action(async (id, opts) => {
      const data = await post(`/api/v1/embeddings/profiles/${id}/${path}`, {})
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
  }

  embedding.command('usage <id>').description('show aggregated provider usage metrics').option('--json', 'output raw JSON').action(async (id, opts) => {
    const data = await get(`/api/v1/embeddings/profiles/${id}/usage`)
    if (opts.json) return printJson(data)
    printKv(data as Record<string, unknown>)
  })

  embedding.command('generations <profileId>').description('list immutable embedding generations').option('--json', 'output raw JSON').action(async (profileId, opts) => {
    const data = await get<{ items: Record<string, unknown>[] }>(`/api/v1/embeddings/profiles/${profileId}/generations`)
    if (opts.json) return printJson(data)
    printTable(data.items, ['id', 'generationNumber', 'status', 'model', 'dimensions', 'coveredDocuments', 'totalDocuments'])
  })

  embedding.command('activate-generation <generationId>').description('atomically activate a completed generation').option('--json', 'output raw JSON').action(async (generationId, opts) => {
    const data = await post(`/api/v1/embeddings/generations/${generationId}/activate`, {})
    if (opts.json) return printJson(data)
    printKv(data as Record<string, unknown>)
  })

  embedding.command('rebuild <id>')
    .option('--kind <kind>', 'full|forced', 'full')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await post(`/api/v1/embeddings/profiles/${id}/rebuild`, { kind: opts.kind })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  embedding.command('cleanup <id>').option('--json', 'output raw JSON').action(async (id, opts) => {
    const data = await post(`/api/v1/embeddings/profiles/${id}/cleanup`, {})
    if (opts.json) return printJson(data)
    printKv(data as Record<string, unknown>)
  })

  embedding.command('job <id>').option('--items', 'include job items').option('--json', 'output raw JSON').action(async (id, opts) => {
    const data = opts.items
      ? await get(`/api/v1/embeddings/jobs/${id}/items`)
      : await get(`/api/v1/embeddings/jobs/${id}`)
    if (opts.json) return printJson(data)
    if (Array.isArray(data)) printTable(data as Record<string, unknown>[], ['id', 'documentId', 'status', 'attemptCount'])
    else printKv(data as Record<string, unknown>)
  })

  for (const [name, path, description] of [
    ['cancel', 'cancel', 'request cancellation of a running job'],
    ['resume', 'resume', 'resume a paused or cancelled job'],
    ['retry-failed', 'retry-failed', 'requeue failed job items'],
  ] as const) {
    embedding.command(`${name} <id>`).description(description).option('--json', 'output raw JSON').action(async (id, opts) => {
      const data = await post(`/api/v1/embeddings/jobs/${id}/${path}`, {})
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
  }
}
