import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITY_LIMITS } from '@task-weaver/contracts'
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


test('CLI steps stay in the current project and do not advertise unavailable invocation', () => {
  const projectId = '00000000-0000-4000-8000-000000000001'
  const rendered = renderWorkerCapabilityBootstrap(bootstrap(), projectId)
  assert.match(rendered, new RegExp(`tw context search.*--project ${projectId}`))
  assert.match(rendered, new RegExp(`tw memory search.*--project ${projectId}`))
  assert.ok(!rendered.includes('tw mcp search'))
  assert.ok(!rendered.includes('tw context run.'))
  assert.ok(!renderWorkerCapabilityBootstrap(bootstrap(), 'untrusted; broaden-scope').includes('untrusted;'))
  assert.ok(Buffer.byteLength(rendered) <= CAPABILITY_LIMITS.bootstrapBytes)
})
