import { CAPABILITY_LIMITS, capabilityBootstrapSchema } from '@task-weaver/contracts'
import { ApiError, request } from './client.js'

const fallback = 'Capability bootstrap is unavailable or incompatible. Capability access, inventory and runtime readiness are unknown. Use scoped discovery only when relevant; do not assume invocation/write authority or install dependencies. Follow the current task and launch-mode protocol.'
const heading = 'Worker Capability Bootstrap (instruction access is not proof of useful inventory; discover content on demand):\n'

/** Render only the bounded capability contract, never a supervisor's generic command catalog. */
export function renderWorkerCapabilityBootstrap(value: unknown): string {
  const parsed = capabilityBootstrapSchema.safeParse(value)
  if (!parsed.success) return fallback
  const rendered = heading + JSON.stringify(parsed.data)
  return Buffer.byteLength(rendered, 'utf8') <= CAPABILITY_LIMITS.bootstrapBytes ? rendered : fallback
}

/** The worker handle reauthorizes this read against the exact run and parent ceiling. */
export async function loadWorkerCapabilityBootstrap(
  credential: { apiUrl: string; apiKey: string },
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await request<{ capabilityBootstrap?: unknown }>('GET', '/api/v1/context/bootstrap', undefined, {
      credential, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    return renderWorkerCapabilityBootstrap(result.capabilityBootstrap)
  } catch (error) {
    if (signal.aborted || error instanceof ApiError && [401, 403].includes(error.status)) throw error
    return fallback
  }
}
