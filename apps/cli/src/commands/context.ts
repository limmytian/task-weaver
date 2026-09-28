import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, basename, relative, sep, dirname, join } from 'node:path'
import { Command } from 'commander'
import { get, post, patch } from '../client.js'
import { printJson, printTable, printKv } from '../output.js'

interface PackageFilePayload {
  path: string
  contentBase64: string
  contentType: string
  isReadableText: boolean
  isExecutable: boolean
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.sh',
  '.py',
  '.rb',
  '.go',
  '.rs',
])

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, content: raw }

  const meta: Record<string, unknown> = {}
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    // Handle arrays in bracket notation: ["a", "b"]
    if (typeof value === 'string' && value.startsWith('[')) {
      try { value = JSON.parse(value) } catch { /* keep as string */ }
    }
    // Strip surrounding quotes
    if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, content: match[2]!.trim() }
}

function collectPackageFiles(rootDir: string): PackageFilePayload[] {
  const files: PackageFilePayload[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      const packagePath = relative(rootDir, fullPath).split(sep).join('/')
      if (!packagePath || packagePath.split('/').includes('..')) {
        throw new Error(`Invalid package file path: ${packagePath}`)
      }

      const content = readFileSync(fullPath)
      const isReadableText = isProbablyReadableText(packagePath, content)
      files.push({
        path: packagePath,
        contentBase64: content.toString('base64'),
        contentType: inferContentType(packagePath, isReadableText),
        isReadableText,
        isExecutable: (statSync(fullPath).mode & 0o111) !== 0,
      })
    }
  }
  visit(rootDir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function inferContentType(path: string, isReadableText: boolean): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml'
  if (isReadableText) return 'text/plain'
  return 'application/octet-stream'
}

function isProbablyReadableText(path: string, content: Buffer): boolean {
  const lower = path.toLowerCase()
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
  if (TEXT_EXTENSIONS.has(extension)) return true
  return !content.includes(0) && !content.subarray(0, 4096).toString('utf8').includes('\uFFFD')
}

function splitCsv(value: string | undefined): string[] | undefined {
  return value?.split(',').map((item) => item.trim()).filter(Boolean)
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function resolveMaterializedFile(rootDir: string, packagePath: string): string {
  const normalized = packagePath.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Invalid package file path: ${packagePath}`)
  }
  const filePath = resolve(rootDir, normalized)
  if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${sep}`)) {
    throw new Error(`Package file path escapes install root: ${packagePath}`)
  }
  return filePath
}

export function registerContext(program: Command): void {
  const ctx = program.command('context').description('discover and retrieve context/skills on demand')
  const pkg = ctx.command('package').description('manage multi-file skill packages')

  ctx
    .command('search <intent>')
    .description('find relevant skills by describing what you need')
    .option('--tags <tags>', 'comma-separated tag filter')
    .option('--limit <n>', 'max results (default: 5)', '5')
    .option('--full', 'return full content instead of summaries')
    .option('--project <id>', 'include project-specific context')
    .option('--project-only', 'exclude global context when --project is set')
    .option('--json', 'output raw JSON')
    .action(async (intent, opts) => {
      const params = new URLSearchParams({ intent })
      if (opts.tags) params.set('tags', opts.tags)
      if (opts.limit) params.set('limit', opts.limit)
      if (opts.full) params.set('mode', 'full')
      if (opts.project) params.set('projectId', opts.project)
      if (opts.projectOnly) params.set('includeGlobal', 'false')
      const data = await get<{ items: unknown[] }>(`/api/v1/context/search?${params}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'summary', 'score'])
    })

  ctx
    .command('get <id>')
    .description('retrieve full content of a specific skill')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/context/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  ctx
    .command('bootstrap')
    .description('get initial context for using Task Weaver')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const data = await get(`/api/v1/context/bootstrap`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  ctx
    .command('list')
    .description('list all available skills')
    .option('--tags <tags>', 'comma-separated tag filter')
    .option('--project <id>', 'include project-specific')
    .option('--all-projects', 'include skills from all projects')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.tags) params.set('tags', opts.tags)
      if (opts.project) params.set('projectId', opts.project)
      if (opts.allProjects) params.set('allProjects', 'true')
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{ items: unknown[] }>(`/api/v1/context/list${qs}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'title', 'summary', 'tags'])
    })

  ctx
    .command('import <file>')
    .description('import a skill from a local markdown file')
    .option('--project <id>', 'scope to a project')
    .option('--json', 'output raw JSON')
    .action(async (file, opts) => {
      const raw = readFileSync(resolve(file), 'utf-8')
      const { meta, content } = parseFrontmatter(raw)
      const title = (meta.name as string) || (meta.title as string) || basename(file, '.md')
      const data = await post('/api/v1/context/import', {
        title,
        content,
        summary: meta.description as string | undefined,
        keywords: meta.keywords as string[] | undefined,
        tags: meta.tags as string[] | undefined,
        projectId: opts.project,
      })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  ctx
    .command('import-dir <dir>')
    .description('import all .md files from a directory as skills')
    .option('--project <id>', 'scope to a project')
    .option('--json', 'output raw JSON')
    .action(async (dir, opts) => {
      const dirPath = resolve(dir)
      const files = readdirSync(dirPath).filter(f => f.endsWith('.md'))
      const skills = files.map(f => {
        const raw = readFileSync(resolve(dirPath, f), 'utf-8')
        const { meta, content } = parseFrontmatter(raw)
        const title = (meta.name as string) || (meta.title as string) || basename(f, '.md')
        return {
          title,
          content,
          summary: meta.description as string | undefined,
          keywords: meta.keywords as string[] | undefined,
          tags: meta.tags as string[] | undefined,
          projectId: opts.project,
        }
      })
      const data = await post<{ items: unknown[]; count: number }>('/api/v1/context/import/batch', { skills })
      if (opts.json) return printJson(data)
      console.log(`Imported ${data.count} skills`)
      printTable(data.items as Record<string, unknown>[], ['id', 'title'])
    })

  pkg
    .command('register <dir>')
    .description('register a skill package from a local directory')
    .option('--name <name>', 'package name (defaults to SKILL.md frontmatter name/title or directory name)')
    .option('--version <version>', 'package version (default: 1.0.0)', '1.0.0')
    .option('--entry <path>', 'entry file path (default: SKILL.md)', 'SKILL.md')
    .option('--project <id>', 'scope to a project')
    .option('--summary <summary>', 'package summary')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--keywords <keywords>', 'comma-separated keywords')
    .option('--json', 'output raw JSON')
    .action(async (dir, opts) => {
      const dirPath = resolve(dir)
      const files = collectPackageFiles(dirPath)
      const entry = files.find((file) => file.path === opts.entry)
      if (!entry) {
        throw new Error(`Package entry file not found: ${opts.entry}`)
      }

      const entryRaw = Buffer.from(entry.contentBase64, 'base64').toString('utf8')
      const { meta } = parseFrontmatter(entryRaw)
      const name = opts.name
        || (meta.name as string)
        || (meta.title as string)
        || basename(dirPath)

      const data = await post('/api/v1/context/packages/register', {
        name,
        description: meta.description as string | undefined,
        version: opts.version,
        sourceType: 'directory',
        entryPath: opts.entry,
        summary: opts.summary ?? meta.description,
        keywords: splitCsv(opts.keywords) ?? (meta.keywords as string[] | undefined),
        tags: splitCsv(opts.tags) ?? (meta.tags as string[] | undefined),
        projectId: opts.project,
        manifest: {
          entryPath: opts.entry,
          fileCount: files.length,
        },
        files,
      })

      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  pkg
    .command('list')
    .description('list registered skill packages')
    .option('--project <id>', 'include project-specific packages')
    .option('--all-projects', 'include packages from all projects')
    .option('--status <status>', 'active|deprecated|archived|deleted')
    .option('--limit <n>', 'max items (default: 50)', '50')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.allProjects) params.set('allProjects', 'true')
      if (opts.status) params.set('status', opts.status)
      if (opts.limit) params.set('limit', opts.limit)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{ items: unknown[] }>(`/api/v1/context/packages${qs}`)
      if (opts.json) return printJson(data)
      const rows = data.items.map((item: any) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        projectId: item.projectId,
        version: item.versions?.[0]?.version,
        updatedAt: item.updatedAt,
      }))
      printTable(rows as Record<string, unknown>[], ['id', 'name', 'status', 'projectId', 'version', 'updatedAt'])
    })

  pkg
    .command('get <id>')
    .description('inspect package manifest, versions, and indexed files')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const data = await get(`/api/v1/context/packages/${id}`)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  pkg
    .command('files <id>')
    .description('list package file metadata')
    .option('--version <version>', 'package version')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams()
      if (opts.version) params.set('version', opts.version)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{ items: unknown[] }>(`/api/v1/context/packages/${id}/files${qs}`)
      if (opts.json) return printJson(data)
      printTable(data.items as Record<string, unknown>[], ['id', 'path', 'kind', 'sizeBytes', 'isReadableText', 'isExecutable'])
    })

  pkg
    .command('read <id> [path]')
    .description('read SKILL.md or another readable package text file')
    .option('--version <version>', 'package version')
    .option('--json', 'output raw JSON')
    .action(async (id, path = 'SKILL.md', opts) => {
      const params = new URLSearchParams({ path })
      if (opts.version) params.set('version', opts.version)
      const data = await get(`/api/v1/context/packages/${id}/read?${params}`)
      if (opts.json) return printJson(data)
      console.log((data as any).content)
    })

  pkg
    .command('install <id>')
    .description('download and materialize a package into the local cache')
    .option('--version <version>', 'package version')
    .option('--cache-dir <dir>', 'cache directory')
    .option('--print-path', 'print only the installed path')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams()
      if (opts.version) params.set('version', opts.version)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<any>(`/api/v1/context/packages/${id}/download${qs}`)
      const cacheDir = resolve(opts.cacheDir ?? join(homedir(), '.cache', 'tw', 'skill-packages'))
      const installDir = resolve(cacheDir, data.packageId, data.version)
      rmSync(installDir, { recursive: true, force: true })
      mkdirSync(installDir, { recursive: true })

      for (const file of data.files ?? []) {
        const content = Buffer.from(file.contentBase64, 'base64')
        const actualSha = sha256Hex(content)
        if (actualSha !== file.sha256) {
          throw new Error(`Hash mismatch for ${file.path}`)
        }
        const filePath = resolveMaterializedFile(installDir, file.path)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content)
        if (file.isExecutable) chmodSync(filePath, 0o755)
      }

      if (opts.json) return printJson({ installedPath: installDir, packageId: data.packageId, version: data.version })
      if (opts.printPath) {
        console.log(installDir)
        return
      }
      console.log(`Installed package ${data.packageId}@${data.version} to ${installDir}`)
    })

  pkg
    .command('health <id>')
    .description('verify package storage objects, sizes, and hashes')
    .option('--version <version>', 'package version')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const params = new URLSearchParams()
      if (opts.version) params.set('version', opts.version)
      const qs = params.toString() ? `?${params}` : ''
      const data = await get<{
        version: string
        checked: number
        ok: number
        failed: number
        items: Record<string, unknown>[]
      }>(`/api/v1/context/packages/${id}/health${qs}`)
      if (opts.json) return printJson(data)
      printKv({ version: data.version, checked: data.checked, ok: data.ok, failed: data.failed })
      printTable(data.items, ['path', 'status', 'expectedSizeBytes', 'actualSizeBytes'])
    })

  pkg
    .command('reindex <id>')
    .description('rebuild indexed skill documents from readable package files')
    .option('--version <version>', 'package version')
    .option('--paths <paths>', 'comma-separated package paths to reindex')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.version) body.version = opts.version
      if (opts.paths) body.paths = splitCsv(opts.paths)
      const data = await post<{
        version: string
        reindexed: Record<string, unknown>[]
        skipped: Record<string, unknown>[]
      }>(`/api/v1/context/packages/${id}/reindex`, body)
      if (opts.json) return printJson(data)
      printKv({ version: data.version, reindexed: data.reindexed.length, skipped: data.skipped.length })
      if (data.skipped.length > 0) printTable(data.skipped, ['path', 'reason'])
    })

  pkg
    .command('update <id>')
    .description('update package metadata or lifecycle status')
    .option('--name <name>', 'new package name')
    .option('--description <description>', 'new package description')
    .option('--status <status>', 'active|deprecated|archived|deleted')
    .option('--summary <summary>', 'new package summary')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--keywords <keywords>', 'comma-separated keywords')
    .option('--json', 'output raw JSON')
    .action(async (id, opts) => {
      const body: Record<string, unknown> = {}
      if (opts.name) body.name = opts.name
      if (opts.description) body.description = opts.description
      if (opts.status) body.status = opts.status
      if (opts.summary) body.summary = opts.summary
      if (opts.tags) body.tags = splitCsv(opts.tags)
      if (opts.keywords) body.keywords = splitCsv(opts.keywords)
      const data = await patch(`/api/v1/context/packages/${id}`, body)
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })

  pkg
    .command('version-status <id> <version> <status>')
    .description('update package version lifecycle status')
    .option('--json', 'output raw JSON')
    .action(async (id, version, status, opts) => {
      const data = await patch(`/api/v1/context/packages/${id}/versions/${version}`, { status })
      if (opts.json) return printJson(data)
      printKv(data as Record<string, unknown>)
    })
}
