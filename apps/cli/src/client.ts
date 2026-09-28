import { loadConfig } from './config.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: {
    actorId?: string
    actorType?: 'human' | 'agent'
    omitAuth?: boolean
  },
): Promise<T> {
  const config = loadConfig()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Actor-Type': opts?.actorType ?? 'agent',
    'X-Actor-Id': opts?.actorId ?? process.env.TW_ACTOR_ID ?? config.actorId ?? 'tw-cli',
  }
  if (config.apiKey && !opts?.omitAuth) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const url = `${config.apiUrl}${path}`
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    let errBody: unknown
    try { errBody = JSON.parse(text) } catch { errBody = text }
    const msg = typeof errBody === 'object' && errBody !== null && 'error' in errBody
      ? String((errBody as { error: unknown }).error)
      : `HTTP ${res.status}`
    throw new ApiError(res.status, msg, errBody)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const get = <T>(path: string) => request<T>('GET', path)
export const post = <T>(path: string, body: unknown) => request<T>('POST', path, body)
export const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body)
export const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
export const del = <T>(path: string) => request<T>('DELETE', path)
