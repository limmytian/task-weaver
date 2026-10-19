import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { MCP_SERVER_LIMITS, mcpServerToolErrorSchema } from '@task-weaver/contracts'
import { createMcpToolCaller, createTaskWeaverMcpServer, McpToolFailure } from '@task-weaver/core/mcp-server'
import { ApiError, request } from './client.js'
import { loadConfig } from './config.js'

export async function serveMcp(options: { readOnly?: boolean } = {}): Promise<void> {
  const config = loadConfig()
  if (!config.apiKey) throw new Error('MCP requires a configured Task Weaver API key.')
  const url = new URL(config.apiUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MCP requires an HTTP(S) API URL without credentials, query or fragment.')
  }
  const credential = { apiUrl: config.apiUrl, apiKey: config.apiKey }
  // Verify before accepting MCP messages; tool calls still verify the key again.
  try { await request('GET', '/api/v1/auth/me', undefined, { credential, signal: AbortSignal.timeout(MCP_SERVER_LIMITS.timeoutMs) }) }
  catch { throw new Error('MCP authentication failed. Verify the API URL and key configuration.') }
  const controller = new AbortController()
  const call = createMcpToolCaller(async (name, input, signal) => {
    try {
      const result = await request<{ structuredContent?: { ok: boolean; data?: unknown; error?: unknown } }>('POST', `/api/v1/mcp-server/tools/${name}`, input, { credential, signal })
      const value = result.structuredContent
      if (!value || typeof value.ok !== 'boolean') throw new Error('Invalid MCP API result')
      if (!value.ok) {
        const parsed = mcpServerToolErrorSchema.parse(value)
        throw new McpToolFailure(parsed.error.code, parsed.error.message, parsed.error.approvalId)
      }
      return value.data
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) throw new McpToolFailure('unauthenticated', 'Authentication required.')
        if (error.status === 403) throw new McpToolFailure('forbidden', 'Access denied.')
        if (error.status === 400) throw new McpToolFailure('validation_error', 'Invalid tool arguments.')
        if (error.status === 404) throw new McpToolFailure('not_found', 'Resource not found or the server does not support inbound MCP.')
      }
      throw error
    }
  }, { readOnly: options.readOnly, signal: controller.signal })
  const server = createTaskWeaverMcpServer(call, { ...options, visibleTools: async () => {
    const result = await request<{ tools: string[] }>('GET', '/api/v1/mcp-server/catalog', undefined, { credential, signal: AbortSignal.timeout(MCP_SERVER_LIMITS.timeoutMs) })
    return result.tools
  } })
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MCP_SERVER_LIMITS.requestBytes })
  let stopping = false
  let resolveStopped: () => void = () => {}
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  const stop = () => {
    if (stopping) return
    stopping = true
    controller.abort()
    void server.close().catch(() => { process.stderr.write('MCP shutdown failed.\n'); process.exitCode = 1 }).finally(() => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      process.stdin.removeListener('end', stop)
      resolveStopped()
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stdin.once('end', stop)
  transport.onclose = stop
  transport.onerror = () => { process.stderr.write('MCP stdio transport failed.\n'); stop() }
  try {
    await server.connect(transport)
    await stopped
  } finally {
    stop()
    await stopped
  }
}
