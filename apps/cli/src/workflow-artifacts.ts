import { constants, copyFileSync, createReadStream, mkdirSync, realpathSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, resolve, join, sep } from 'node:path'

export type LocalWorkflowOutput = {
  id: string; requirementId: string; nodeId: string | null; relativePath: string | null;
  sizeBytes: number | null; sha256: string | null; type: string;
}

export function workflowArtifactRoot(): string {
  return resolve(process.env.TW_ARTIFACT_ROOT ?? join(homedir(), '.task-weaver', 'artifacts'))
}

export function localWorkflowOutputPath(relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe artifact relative path')
  const root = realpathSync(workflowArtifactRoot())
  const path = realpathSync(resolve(root, relativePath))
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Artifact path escapes the configured root')
  return path
}

async function checksum(path: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
  return digest.digest('hex')
}

export async function storeWorkflowArtifact(requirementId: string, file: string, nodeId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requirementId)) throw new Error('A valid requirement ID is required')
  if (!statSync(file).isFile()) throw new Error('Local output must be a regular file')
  const root = workflowArtifactRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const canonicalRoot = realpathSync(root)
  const relativePath = `${requirementId}/${randomUUID()}-${basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const destination = resolve(canonicalRoot, relativePath)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  if (realpathSync(dirname(destination)) !== join(canonicalRoot, requirementId)) throw new Error('Artifact directory contains a symbolic link')
  copyFileSync(file, destination, constants.COPYFILE_EXCL)
  return { nodeId, relativePath, sizeBytes: statSync(destination).size, sha256: await checksum(destination) }
}

export async function probeWorkflowArtifact(output: LocalWorkflowOutput, nodeId: string | undefined, signal?: AbortSignal): Promise<{ availability: 'available' | 'missing' | 'changed'; reason: string }> {
  if (!nodeId || output.nodeId !== nodeId) throw new Error(`Local output ${output.id} belongs to another node`)
  try {
    const path = localWorkflowOutputPath(output.relativePath ?? '')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== Number(output.sizeBytes)) return { availability: 'changed', reason: 'Artifact type or size does not match the registered manifest' }
    if (await checksum(path, signal) !== output.sha256) return { availability: 'changed', reason: 'Artifact checksum does not match the registered manifest' }
    return { availability: 'available', reason: 'File size and SHA-256 checksum verified on the producing node' }
  } catch (error) {
    if (signal?.aborted) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { availability: 'missing', reason: 'Artifact file is missing from the producing node' }
    throw error
  }
}
