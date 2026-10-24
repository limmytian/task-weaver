import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCapabilityBootstrap } from '../../../packages/core/src/mcp-server/bootstrap.js'
import { CAPABILITY_LIMITS, mcpServerCatalog } from '@task-weaver/contracts'
import { renderWorkerCapabilityBootstrap } from './worker-capability-bootstrap.js'

function bootstrap() {
  return {
    schemaVersion: 1, transport: 'stdio or Streamable HTTP', guidance: 'Discover relevant summaries and inspect exact versions. Optional abstention is valid.',
    tools: ['tw_context_search', 'tw_context_get'],
    capabilities: {
      skills: { state: 'available', executionMode: 'instructions' },
      skillPackages: { state: 'available', executionMode: 'instructions' },
      memories: { state: 'available', executionMode: 'remote' },
      externalTools: { state: 'unavailable', reason: 'not_configured', remediation: 'Request explicit project invocation access.' },
      hostedExecution: { state: 'unavailable', reason: 'not_configured', remediation: 'An operator must provision an approved runtime.' },
    },
    loading: { strategy: 'on_demand', maxSummaryResults: 20, maxSummaryBytes: 16384, maxDependencyNodes: 100 },
    authorization: 'recheck_each_operation',
  }
}

test('worker bootstrap renders actual instruction access without asserting content or runtime readiness', () => {
  const rendered = renderWorkerCapabilityBootstrap(bootstrap())
  assert.match(rendered, /tw_context_search/)
  assert.match(rendered, /not proof of useful inventory/)
  assert.match(rendered, /not_configured/)
  assert.match(rendered, /instructions/)
  assert.ok(Buffer.byteLength(rendered) <= CAPABILITY_LIMITS.bootstrapBytes)
})

test('missing, incompatible and oversized bootstrap remain honest and bounded', () => {
  for (const value of [undefined, { ...bootstrap(), schemaVersion: 2 }, { ...bootstrap(), guidance: 'x'.repeat(2001) }, { ...bootstrap(), unexpectedCatalog: ['supervisor-only'] }]) {
    const rendered = renderWorkerCapabilityBootstrap(value)
    assert.match(rendered, /unknown/)
    assert.ok(!rendered.includes('supervisor-only'))
    assert.ok(Buffer.byteLength(rendered) <= CAPABILITY_LIMITS.bootstrapBytes)
  }
})


test('the live server bootstrap including stage guidance fits the worker prompt budget', () => {
  const result = buildCapabilityBootstrap(mcpServerCatalog.map(tool => tool.name), { state: 'available', executionMode: 'isolated' })
  const rendered = renderWorkerCapabilityBootstrap(result)
  assert.match(rendered, /Worker Capability Bootstrap/)
  assert.match(rendered, /tw_skills_run/)
  assert.ok(Buffer.byteLength(rendered) <= CAPABILITY_LIMITS.bootstrapBytes)
})
