import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { executionDelegationSchema, type ExecutionDelegation } from '@task-weaver/contracts'

export interface TaskCapability { delegation: ExecutionDelegation; token: string }
export interface TaskAccessBroker {
  apiUrl: string
  apiKey: string
  close(): Promise<void>
}
const identifier = '[0-9a-fA-F-]{36}'
const readPaths = new RegExp(`^/api/v1/(?:auth/me|projects(?:/${identifier}(?:/(?:requirements|tasks))?)?|tasks(?:/${identifier}(?:/(?:claim|comments|notes|repositories))?)?|requirements/${identifier}(?:/(?:slices|repositories))?|documents(?:/${identifier}(?:/(?:versions(?:/[0-9]+)?|links|backlinks))?)?|repositories(?:/${identifier})?|search/(?:tasks|requirements|documents(?:/fulltext)?|all)|context/(?:search|list|bootstrap|${identifier}))/?$`)
const writePaths = new RegExp(`^/api/v1/tasks/${identifier}/(?:status|claim|release|heartbeat|comments|notes)/?$`)
const patchPaths = new RegExp(`^/api/v1/(?:tasks/${identifier}(?:/status)?|documents/${identifier})/?$`)
const secretDigest = (value: string) => createHash('sha256').update(value).digest()

/** The child receives a local capability handle; upstream tokens and supervisor credentials stay here. */
export async function createTaskAccessBroker(options: {
  apiUrl: string
  capability: TaskCapability
  renew: (id: string) => Promise<TaskCapability>
  revoke: (id: string) => Promise<unknown>
  onInvalidation?: () => void
  fetch?: typeof fetch
}): Promise<TaskAccessBroker> {
  function validateCapability(value: TaskCapability) {
    executionDelegationSchema.parse(value.delegation)
    const expiry = Date.parse(value.delegation.expiresAt)
    if (!/^twd_[0-9a-f]{64}$/.test(value.token) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 15 * 60_000) throw new Error('Invalid task capability')
  }
  validateCapability(options.capability)
  const origin = new URL(options.apiUrl)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Task broker requires an API origin')
  const handle = `twb_${randomBytes(32).toString('hex')}`
  const verifier = secretDigest(`Bearer ${handle}`)
  let capability = options.capability
  let validating = false
  let closed = false
  let validationTimer: ReturnType<typeof setInterval> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let renewalTimer: ReturnType<typeof setTimeout> | undefined
  let renewing: Promise<void> | undefined
  const requests = new Set<AbortController>()
  const fetchUpstream = options.fetch ?? fetch
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    const reject = (status: number, message: string) => { response.writeHead(status); response.end(JSON.stringify({ error: message })) }
    if (closed || Date.parse(capability.delegation.expiresAt) <= Date.now()) return reject(401, 'Task access ended')
    if (!timingSafeEqual(verifier, secretDigest(request.headers.authorization ?? ''))) return reject(401, 'Task access requires a capability')
    const path = request.url ?? ''
    if (!path.startsWith('/api/v1/') || path.startsWith('//')) return reject(403, 'Task access route denied')
    const url = new URL(path, 'http://127.0.0.1')
    const method = request.method ?? 'GET'
    const allowed = method === 'GET' ? readPaths.test(url.pathname) : method === 'POST' ? writePaths.test(url.pathname) : method === 'PATCH' ? patchPaths.test(url.pathname) : false
    if (!allowed) return reject(403, 'Task access route denied')
    await renewing
    if (closed || Date.parse(capability.delegation.expiresAt) <= Date.now()) return reject(401, 'Task access ended')
    const controller = new AbortController()
    requests.add(controller)
    const onClose = () => { if (!response.writableFinished) controller.abort() }
    response.once('close', onClose)
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) return reject(413, 'Task request is too large')
        chunks.push(Buffer.from(chunk))
      }
      if (closed || Date.parse(capability.delegation.expiresAt) <= Date.now()) return reject(401, 'Task access ended')
      const upstream = await fetchUpstream(`${origin.origin}${url.pathname}${url.search}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${capability.token}`, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
      })
      const payload = await upstream.text()
      if (closed || Date.parse(capability.delegation.expiresAt) <= Date.now()) { invalidate(); return }
      response.writeHead(upstream.status)
      response.end(payload)
      if (upstream.status === 401) invalidate()
    } catch {
      if (!response.destroyed && !response.writableEnded) reject(503, 'Task access unavailable')
    } finally {
      response.off('close', onClose)
      requests.delete(controller)
    }
  })
  function invalidate() {
    if (closed) return
    closed = true
    if (renewalTimer) clearTimeout(renewalTimer)
    if (expiryTimer) clearTimeout(expiryTimer)
    if (validationTimer) clearInterval(validationTimer)
    for (const request of requests) request.abort()
    server.closeAllConnections()
    server.close()
    options.onInvalidation?.()
  }
  function scheduleRenewal() {
    if (closed) return
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = setTimeout(invalidate, Math.max(0, Date.parse(capability.delegation.expiresAt) - Date.now()))
    expiryTimer.unref()
    renewalTimer = setTimeout(() => {
      if (requests.size > 0) { scheduleRenewal(); return }
      renewing = (async () => {
        let renewed: TaskCapability | undefined
        try {
          renewed = await options.renew(capability.delegation.id)
          validateCapability(renewed)
          const original = capability.delegation
          const next = renewed.delegation
          if (closed) { await options.revoke(next.id).catch(() => {}); return }
          if (JSON.stringify(next.initiator) !== JSON.stringify(original.initiator) || next.delegatorActorId !== original.delegatorActorId || next.runId !== original.runId || next.executorActorId !== original.executorActorId || next.parentCredentialId !== original.parentCredentialId
            || next.requirementId !== original.requirementId || next.projectId !== original.projectId || next.purpose !== original.purpose || next.leaseGeneration !== original.leaseGeneration
            || JSON.stringify(next.taskIds) !== JSON.stringify(original.taskIds) || JSON.stringify(next.repositoryIds) !== JSON.stringify(original.repositoryIds)
            || Date.parse(next.expiresAt) <= Date.now() || Date.parse(next.expiresAt) > Date.now() + 15 * 60_000) throw new Error('Invalid task capability renewal')
          capability = renewed
          scheduleRenewal()
        } catch {
          if (renewed) await options.revoke(renewed.delegation.id).catch(() => {})
          invalidate()
        } finally { renewing = undefined }
      })()
    }, Math.max(1000, Date.parse(capability.delegation.expiresAt) - Date.now() - 45_000))
    renewalTimer.unref()
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Task broker did not bind loopback')
  scheduleRenewal()
  validationTimer = setInterval(() => {
    if (closed || renewing || validating || Date.parse(capability.delegation.expiresAt) - Date.now() < 45_000) return
    validating = true
    const controller = new AbortController()
    requests.add(controller)
    void fetchUpstream(`${origin.origin}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${capability.token}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
    }).then(async response => {
      await response.body?.cancel()
      if (!response.ok) invalidate()
    }).catch(() => { invalidate() }).finally(() => { validating = false; requests.delete(controller) })
  }, 1000)
  validationTimer.unref()
  return {
    apiUrl: `http://127.0.0.1:${address.port}`, apiKey: handle,
    async close() {
      invalidate()
      await renewing
      await options.revoke(capability.delegation.id).catch(() => {})
    },
  }
}
