import { test } from 'node:test'
import assert from 'node:assert'
import { registerMcpServerSchema, searchMcpToolsSchema, updateMcpServerSchema } from './mcp.js'

const stdioConfig = {
  command: 'node',
  args: ['server.js'],
}

test('MCP local scope consent validation', async (t) => {
  await t.test('rejects local stdio registration without explicit consent', () => {
    const result = registerMcpServerSchema.safeParse({
      name: 'local-tools',
      transport: 'stdio',
      config: stdioConfig,
      clientId: 'cli-1',
      nodeId: 'node-1',
      scope: 'local',
    })

    if (result.success) assert.fail('Expected local scope registration without consent to fail')
    assert.deepEqual(result.error.flatten().fieldErrors.localScopeConsent, [
      'localScopeConsent=true is required to share a stdio MCP server with scope=local',
    ])
  })

  await t.test('rejects local stdio registration without node id', () => {
    const result = registerMcpServerSchema.safeParse({
      name: 'local-tools',
      transport: 'stdio',
      config: stdioConfig,
      clientId: 'cli-1',
      scope: 'local',
      localScopeConsent: true,
    })

    if (result.success) assert.fail('Expected local scope registration without node id to fail')
    assert.deepEqual(result.error.flatten().fieldErrors.nodeId, [
      'nodeId is required when sharing a stdio MCP server with scope=local',
    ])
  })

  await t.test('accepts local stdio registration with node id and explicit consent', () => {
    const result = registerMcpServerSchema.safeParse({
      name: 'local-tools',
      transport: 'stdio',
      config: stdioConfig,
      clientId: 'cli-1',
      nodeId: 'node-1',
      scope: 'local',
      localScopeConsent: true,
    })

    assert.equal(result.success, true)
  })

  await t.test('rejects update to local scope without explicit consent', () => {
    const result = updateMcpServerSchema.safeParse({
      nodeId: 'node-1',
      scope: 'local',
    })

    if (result.success) assert.fail('Expected local scope update without consent to fail')
    assert.deepEqual(result.error.flatten().fieldErrors.localScopeConsent, [
      'localScopeConsent=true is required to share a stdio MCP server with scope=local',
    ])
  })
})

test('MCP project scope validation', async (t) => {
  await t.test('accepts project scoped HTTP server registration', () => {
    const result = registerMcpServerSchema.safeParse({
      name: 'project-http-tools',
      projectId: '00000000-0000-4000-8000-000000000001',
      transport: 'streamable-http',
      config: { url: 'https://mcp.example.test/sse' },
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.projectId, '00000000-0000-4000-8000-000000000001')
    }
  })

  await t.test('coerces includeGlobal for project scoped tool search', () => {
    const result = searchMcpToolsSchema.safeParse({
      intent: 'read files',
      projectId: '00000000-0000-4000-8000-000000000001',
      includeGlobal: 'false',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includeGlobal, false)
    }
  })
})
