export type ApiTransportCode = 'network_dns' | 'network_tls' | 'network_timeout' | 'network_cancelled' | 'network_connection' | 'network_failed' | 'invalid_response'

const descriptions: Record<ApiTransportCode, string> = {
  network_dns: 'API hostname lookup failed. Check DNS and network routing.',
  network_tls: 'API TLS validation or handshake failed. Check certificates and the network path.',
  network_timeout: 'API connection or response timed out. Check service health and network routing.',
  network_cancelled: 'API request was cancelled.',
  network_connection: 'API connection failed or closed. Check service health and network routing.',
  network_failed: 'API transport failed. Check service health, DNS and network routing.',
  invalid_response: 'API returned an invalid JSON response. Check the API endpoint and reverse proxy.',
}

/** Safe diagnostics contain no endpoint, credential, raw response or nested socket error. */
export class ApiTransportError extends Error {
  readonly mutationMayHaveCommitted: boolean
  constructor(readonly code: ApiTransportCode, method: string) {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
    super(`[${code}] ${descriptions[code]}${mutation ? ' The operation may have committed; inspect current state before retrying. No automatic retry was made.' : ''}`)
    this.name = code === 'network_cancelled' ? 'AbortError' : 'ApiTransportError'
    this.mutationMayHaveCommitted = mutation
  }
}

export function transportError(error: unknown, method: string, signal?: AbortSignal): ApiTransportError {
  if (signal?.aborted) return new ApiTransportError(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'network_timeout' : 'network_cancelled', method)
  const codes = new Set<string>()
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 3) return
    const item = value as { name?: string; code?: string; cause?: unknown; errors?: unknown[] }
    if (typeof item.code === 'string') codes.add(item.code)
    if (item.name === 'TimeoutError') codes.add('ETIMEDOUT')
    if (item.name === 'AbortError') codes.add('ABORT_ERR')
    visit(item.cause, depth + 1)
    if (Array.isArray(item.errors)) for (const nested of item.errors.slice(0, 8)) visit(nested, depth + 1)
  }
  visit(error, 0)
  const has = (...values: string[]) => values.some(value => codes.has(value))
  const code: ApiTransportCode = has('ENOTFOUND', 'EAI_AGAIN') ? 'network_dns'
    : [...codes].some(value => value.startsWith('ERR_TLS_') || value.startsWith('ERR_SSL_') || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(value)) ? 'network_tls'
    : has('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT') ? 'network_timeout'
    : has('ABORT_ERR') ? 'network_cancelled'
    : has('ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET') ? 'network_connection'
    : 'network_failed'
  return new ApiTransportError(code, method)
}
