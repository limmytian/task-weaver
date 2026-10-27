import { CAPABILITY_LIMITS, capabilityBootstrapSchema } from '@task-weaver/contracts'
import { ApiError, request } from './client.js'

const fallback = 'Capability bootstrap is unavailable or incompatible. Capability access, inventory and runtime readiness are unknown. Use scoped discovery only when relevant; do not assume invocation/write authority or install dependencies. Follow the current task and launch-mode protocol.'
const heading = 'Worker Capability Bootstrap (instruction access is not proof of useful inventory; discover content on demand):\n'

/** Render only the bounded capability contract, never a supervisor's generic command catalog. */
export function renderWorkerCapabilityBootstrap(value: unknown, projectId?: string): string {
  const parsed = capabilityBootstrapSchema.safeParse(value)
  if (!parsed.success) return fallback
  const rendered = heading + JSON.stringify(parsed.data)
  if (Buffer.byteLength(rendered, 'utf8') > CAPABILITY_LIMITS.bootstrapBytes) return fallback
  if (!projectId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)) return rendered
  const commands: string[] = []
  const capabilities = parsed.data.capabilities
  if (capabilities.skills.state === 'available') commands.push(`tw context search "<relevant topic>" --project ${projectId} --json; then tw context get <skill-id> --json`)
  if (capabilities.skillPackages.state === 'available') commands.push(`tw context package list --project ${projectId} --json; read selected files with an exact --version`)
  if (capabilities.memories.state === 'available') commands.push(`tw memory search "<relevant topic>" --project ${projectId} --json; then tw memory get <memory-id> --json`)
  if (capabilities.externalTools.state === 'available') commands.push(`tw mcp search "<intent>" --project ${projectId} --json; tw mcp tool <tool-id> --json; invoke only with the inspected --schema-hash and current approvals`)
  if (capabilities.hostedExecution.state === 'available' && parsed.data.execution) commands.push('Resolve an exact package version and inspect tw context runtimes --json before a confirmed tw context run. Never install a runtime automatically.')
  const withCommands = rendered + (commands.length ? '\nCurrent-project CLI steps (use only relevant steps):\n' + commands.join('\n') : '')
  return Buffer.byteLength(withCommands, 'utf8') <= CAPABILITY_LIMITS.bootstrapBytes ? withCommands : rendered
}

/** The worker handle reauthorizes this read against the exact run and parent ceiling. */
export async function loadWorkerCapabilityBootstrap(
  credential: { apiUrl: string; apiKey: string },
  signal: AbortSignal,
  projectId?: string,
): Promise<string> {
  try {
    const result = await request<{ capabilityBootstrap?: unknown }>('GET', '/api/v1/context/bootstrap', undefined, {
      credential, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    return renderWorkerCapabilityBootstrap(result.capabilityBootstrap, projectId)
  } catch (error) {
    if (signal.aborted || error instanceof ApiError && [401, 403].includes(error.status)) throw error
    return fallback
  }
}
