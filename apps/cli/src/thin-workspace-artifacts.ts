import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from './async-command.js'
import { buildAiEnvironment } from './repository-credentials.js'
import type { CompositeWorkspace } from './repository-workspace.js'

/** Capture task-local changes without committing, pushing, or touching another worktree. */
export async function captureThinPatches(workspace: CompositeWorkspace, assertAuthority: () => Promise<void>) {
  const directory = join(workspace.rootPath, 'artifacts')
  await mkdir(directory, { mode: 0o700 })
  const artifacts: Array<{ repositoryId: string; baseCommit: string; branch: string; path: string }> = []
  for (const repository of workspace.repositories) {
    if (!repository.headCommit || !/^[a-f0-9]{40,64}$/i.test(repository.headCommit)) throw new Error('Workspace base commit is missing')
    await assertAuthority()
    const environment = buildAiEnvironment(process.env)
    const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repository.worktreePath, env: environment })
    if (!head.ok || head.stdout.trim() !== repository.headCommit) throw new Error('Workspace HEAD changed; inspect the attempt before delivery')
    const stage = await runCommand('git', ['add', '-A', '--', '.'], { cwd: repository.worktreePath, env: environment })
    if (!stage.ok) throw new Error('Failed to stage task workspace changes')
    const chunks: Buffer[] = []
    let size = 0
    const diff = await runCommand('git', ['diff', '--cached', '--binary', '--full-index', repository.headCommit, '--'], { cwd: repository.worktreePath, env: environment, maxOutputBytes: 50 * 1024 * 1024, onStdout: chunk => { size += chunk.length; if (size <= 50 * 1024 * 1024) chunks.push(chunk) } })
    if (!diff.ok || diff.outputTruncated) throw new Error('Task patch could not be captured within the artifact limit')
    if (!size) continue
    await assertAuthority()
    const path = join(directory, `${repository.repositoryId}.patch`)
    await writeFile(path, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' })
    artifacts.push({ repositoryId: repository.repositoryId, baseCommit: repository.headCommit, branch: repository.workingBranch, path })
  }
  return artifacts
}

/** Package local patches with their frozen manifest for authenticated artifact upload. */
export async function packageThinArtifacts(workspace: CompositeWorkspace, patches: Array<{ repositoryId: string; baseCommit: string; branch: string; path: string }>, assertAuthority: () => Promise<void>, reportPath?: string) {
  const { open } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const { dirname, resolve } = await import('node:path')
  await assertAuthority()
  const manifestFile = await open(workspace.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let manifest: any
  try {
    const info = await manifestFile.stat()
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Workspace manifest is invalid')
    manifest = JSON.parse(await manifestFile.readFile('utf8'))
  } finally { await manifestFile.close() }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length !== workspace.repositories.length || workspace.repositories.some(repo => !manifest.repositories.some((entry: any) => entry.repositoryId === repo.repositoryId && entry.baseCommit === repo.headCommit && entry.workingBranch === repo.workingBranch))) throw new Error('Workspace manifest changed')
  const directory = resolve(join(workspace.rootPath, 'artifacts'))
  const parts = []
  let total = 0
  for (const patch of patches) {
    const path = resolve(patch.path)
    if (dirname(path) !== directory || !workspace.repositories.some(repo => repo.repositoryId === patch.repositoryId && repo.headCommit === patch.baseCommit && repo.workingBranch === patch.branch)) throw new Error('Artifact is outside the frozen workspace manifest')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('Artifact must be a regular file')
      total += info.size
      if (total > 30 * 1024 * 1024) throw new Error('Task artifacts exceed the upload limit')
      const bytes = await file.readFile()
      if (bytes.length !== info.size) throw new Error('Artifact changed while reading')
      parts.push({ repositoryId: patch.repositoryId, baseCommit: patch.baseCommit, branch: patch.branch, encoding: 'base64', patch: bytes.toString('base64') })
    } finally { await file.close() }
  }
  let report: string | null = null
  if (reportPath) {
    const path = resolve(reportPath)
    if (dirname(path) !== resolve(workspace.rootPath) || path !== resolve(join(workspace.rootPath, 'result.md'))) throw new Error('Task report must be result.md at the workspace root')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Task report is unavailable or too large')
      const bytes = await file.readFile()
      if (bytes.length !== info.size) throw new Error('Task report changed while reading')
      report = bytes.toString('utf8').trim()
    } finally { await file.close() }
  }
  if (!parts.length && !report) throw new Error('No task artifacts were produced')
  await assertAuthority()
  const path = join(directory, 'task-delivery.json')
  await writeFile(path, JSON.stringify({ version: 1, manifest, report, repositories: parts }) + '\n', { mode: 0o600, flag: 'wx' })
  return path
}

/** Upload and bind the package only while the server still accepts this attempt. */
export async function publishThinArtifact(options: {
  apiUrl: string
  apiKey: string
  projectId: string
  attemptId: string
  workerId: string
  token: string
  path: string
  assertAuthority: () => Promise<void>
  signal?: AbortSignal
}) {
  const { constants } = await import('node:fs')
  const { open } = await import('node:fs/promises')
  const { Readable } = await import('node:stream')
  await options.assertAuthority()
  const file = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let uploaded: Response
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('Task artifact is unavailable or too large')
    const headers = new Headers({ authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/octet-stream', 'content-length': String(info.size), 'x-tw-attachment-metadata': encodeURIComponent(JSON.stringify({ projectId: options.projectId, title: `Task attempt ${options.attemptId}`, originalFilename: 'task-delivery.json', mimeType: 'application/json' })) })
    uploaded = await fetch(`${options.apiUrl}/api/v1/documents/attachments`, { method: 'POST', headers, body: Readable.toWeb(file.createReadStream({ autoClose: false })), duplex: 'half', redirect: 'error', signal: options.signal } as RequestInit)
  } finally { await file.close() }
  if (!uploaded.ok) throw new Error(`Task artifact upload failed (${uploaded.status})`)
  const document = await uploaded.json() as { id?: string }
  if (!document.id || !/^[0-9a-f-]{36}$/i.test(document.id)) throw new Error('Task artifact upload returned an invalid document')
  await options.assertAuthority()
  const registered = await fetch(`${options.apiUrl}/api/v1/thin-workers/output`, { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: options.attemptId, workerId: options.workerId, token: options.token, documentId: document.id, summary: 'Task workspace delivery' }), redirect: 'error', signal: options.signal })
  if (!registered.ok) throw new Error(`Task artifact binding failed (${registered.status}); uploaded attachment is not an accepted result`)
  const output = await registered.json() as { id?: string }
  if (!output.id || !/^[0-9a-f-]{36}$/i.test(output.id)) throw new Error('Task artifact binding returned an invalid output')
  return { documentId: document.id, outputId: output.id }
}

/** Apply reviewed delivery packages sequentially to a dedicated integration attempt. */
export async function applyThinDeliveries(options: {
  workspace: CompositeWorkspace
  projectId: string
  requirementId: string
  taskId: string
  attemptId: string
  planRevision: number
  packages: string[]
  integrated?: Record<string, { attemptId: string; deliveries: Array<{ repositoryId: string; commit: string }> }>
  assertAuthority: () => Promise<void>
  assertBaseline: () => Promise<void>
}) {
  const { open, realpath } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { resolve } = await import('node:path')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (![options.projectId, options.requirementId, options.taskId, options.attemptId].every(value => uuid.test(value)) || !Number.isSafeInteger(options.planRevision) || options.planRevision < 0) throw new Error('Invalid integration attempt identity')
  if (options.packages.length > 100) throw new Error('Too many task delivery packages')
  const root = resolve(homedir(), '.task-weaver', 'task-workspaces', options.projectId, options.taskId, options.attemptId)
  if (await realpath(options.workspace.rootPath) !== await realpath(root)) throw new Error('Integration requires its own task attempt workspace')
  const env = buildAiEnvironment(process.env)
  await options.assertAuthority()
  await options.assertBaseline()
  for (const repository of options.workspace.repositories) {
    if (!/^[a-zA-Z0-9._-]+$/.test(repository.relativePath) || repository.relativePath === '.' || repository.relativePath === '..') throw new Error('Invalid integration repository path')
    if (await realpath(repository.worktreePath) !== await realpath(join(root, repository.relativePath))) throw new Error('Integration worktree is outside its attempt')
    const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repository.worktreePath, env })
    const status = await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repository.worktreePath, env })
    if (!head.ok || head.stdout.trim() !== repository.headCommit || !status.ok || status.stdout.trim()) throw new Error('Integration workspace must be clean and match its frozen base')
  }
  const patchRoot = join(root, 'integration-inputs')
  await mkdir(patchRoot, { mode: 0o700 })
  const applied: Array<{ repositoryId: string; sourceAttemptId: string }> = []
  for (let index = 0; index < options.packages.length; index++) {
    await options.assertAuthority()
    const source = await open(options.packages[index]!, constants.O_RDONLY | constants.O_NOFOLLOW)
    let delivery: any
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('Delivery package is invalid or too large')
      delivery = JSON.parse(await source.readFile('utf8'))
    } finally { await source.close() }
    if (delivery.version !== 1 || delivery.manifest?.projectId !== options.projectId || delivery.manifest?.requirementId !== options.requirementId || delivery.manifest?.planRevision !== options.planRevision || !uuid.test(delivery.manifest?.taskId ?? '') || !uuid.test(delivery.manifest?.attemptId ?? '') || !Array.isArray(delivery.manifest?.repositories) || !Array.isArray(delivery.repositories) || delivery.repositories.length > options.workspace.repositories.length || new Set(delivery.repositories.map((item: any) => item?.repositoryId)).size !== delivery.repositories.length) throw new Error('Invalid task delivery package')
    for (const item of delivery.repositories) {
      const repository = options.workspace.repositories.find(value => value.repositoryId === item.repositoryId)
      const integrated = options.integrated?.[options.packages[index]!]
      const confirmed = integrated && integrated.attemptId === delivery.manifest.attemptId ? integrated.deliveries.find(value => value.repositoryId === item.repositoryId) : undefined
      if (confirmed) {
        if (!repository || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(confirmed.commit)) throw new Error('Invalid confirmed Git delivery')
        const contained = await runCommand('git', ['merge-base', '--is-ancestor', confirmed.commit, repository.headCommit!], { cwd: repository.worktreePath, env })
        if (!contained.ok) throw new Error('Confirmed Git delivery is missing from the integration branch')
        continue
      }
      if (!repository || item.baseCommit !== repository.headCommit || !delivery.manifest.repositories.some((entry: any) => entry.repositoryId === item.repositoryId && entry.baseCommit === item.baseCommit && entry.workingBranch === item.branch) || item.encoding !== 'base64' || typeof item.patch !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.patch)) throw new Error('Delivery does not match the integration baseline')
      const bytes = Buffer.from(item.patch, 'base64')
      if (!bytes.length || bytes.length > 30 * 1024 * 1024 || bytes.toString('base64') !== item.patch) throw new Error('Invalid patch payload')
      const patchPath = join(patchRoot, `${index}-${repository.repositoryId}.patch`)
      await writeFile(patchPath, bytes, { mode: 0o600, flag: 'wx' })
      const check = await runCommand('git', ['apply', '--check', '--index', '--', patchPath], { cwd: repository.worktreePath, env })
      if (!check.ok) throw new Error('Delivery conflicts with earlier integration work')
      await options.assertAuthority()
      await options.assertBaseline()
      const apply = await runCommand('git', ['apply', '--index', '--', patchPath], { cwd: repository.worktreePath, env })
      if (!apply.ok) throw new Error('Delivery application failed; inspect the preserved integration workspace')
      applied.push({ repositoryId: repository.repositoryId, sourceAttemptId: delivery.manifest.attemptId })
    }
  }
  return applied
}
