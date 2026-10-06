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
    signal?: AbortSignal
    credential?: { apiUrl: string; apiKey: string }
  },
): Promise<T> {
  const config = loadConfig()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const credential = opts?.credential ?? config
  if (credential.apiKey) {
    headers['Authorization'] = `Bearer ${credential.apiKey}`
  }

  const url = `${credential.apiUrl}${path}`
  const res = await fetch(url, {
    method,
    headers,
    signal: opts?.signal,
    redirect: 'error',
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
