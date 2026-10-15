import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requirementWorkflowSchema, workflowFromPreset, workflowNeedsWorktree } from '@task-weaver/contracts'
import { parseWorkflowAgentResult } from './workflow-agent.js'
import { localWorkflowOutputPath, probeWorkflowArtifact, storeWorkflowArtifact } from './workflow-artifacts.js'

test('workflow defaults separate no-output, branch, PR and custom integration actions', () => {
  const basic = workflowFromPreset('basic')
  assert.equal(basic.delivery.method, 'none')
  assert.equal(basic.acceptance.mode, 'skip')
  assert.equal(workflowNeedsWorktree(basic), false)
  assert.equal(workflowFromPreset('git_branch').delivery.method, 'git_branch')
  assert.equal(workflowNeedsWorktree(workflowFromPreset('git_branch')), true)
  assert.equal(workflowFromPreset('git_pr').integration.mode, 'manual')
  assert.throws(() => requirementWorkflowSchema.parse({ ...basic, worktreeMode: 'none', delivery: { ...basic.delivery, method: 'git_branch' } }))
  assert.throws(() => requirementWorkflowSchema.parse({ ...basic, integration: { mode: 'automatic', method: 'publish', instructions: '' } }))
  assert.equal(requirementWorkflowSchema.parse({ ...basic, integration: { mode: 'automatic', method: 'publish', instructions: 'Publish the report to the configured destination' } }).integration.method, 'publish')
})

test('workflow agent decisions require one explicit validated result and real check entries', () => {
  const result = { decision: 'complete', reason: 'Inspected the report', checks: [{ name: 'complete report', status: 'passed', summary: 'All requested sections are present' }] }
  assert.deepEqual(parseWorkflowAgentResult(`WORKFLOW_RESULT: ${JSON.stringify(result)}`), result)
  assert.deepEqual(parseWorkflowAgentResult(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `WORKFLOW_RESULT: ${JSON.stringify(result)}` } })), result)
  assert.throws(() => parseWorkflowAgentResult('APPROVED'))
  assert.throws(() => parseWorkflowAgentResult(`WORKFLOW_RESULT: ${JSON.stringify(result)}\nWORKFLOW_RESULT: ${JSON.stringify(result)}`))
  assert.throws(() => parseWorkflowAgentResult('WORKFLOW_RESULT: {"decision":"complete","reason":""}'))
})

test('durable local outputs detect modification, missing bytes, wrong nodes and path escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-workflow-artifacts-'))
  const previous = process.env.TW_ARTIFACT_ROOT
  process.env.TW_ARTIFACT_ROOT = join(dir, 'artifacts')
  try {
    const source = join(dir, 'report.txt')
    await writeFile(source, 'Report bytes')
    const stored = await storeWorkflowArtifact(randomUUID(), source, 'node-a')
    const output = { id: randomUUID(), requirementId: randomUUID(), type: 'local', ...stored }
    assert.equal((await probeWorkflowArtifact(output, 'node-a')).availability, 'available')
    await assert.rejects(probeWorkflowArtifact(output, 'node-b'), /another node/)
    const path = localWorkflowOutputPath(stored.relativePath)
    await writeFile(path, 'Altered bytes')
    assert.equal((await probeWorkflowArtifact(output, 'node-a')).availability, 'changed')
    await rm(path)
    assert.equal((await probeWorkflowArtifact(output, 'node-a')).availability, 'missing')
    assert.throws(() => localWorkflowOutputPath('../report.txt'), /Unsafe/)
    await symlink(source, join(process.env.TW_ARTIFACT_ROOT!, 'escape'))
    assert.throws(() => localWorkflowOutputPath('escape'), /escapes/)
  } finally {
    if (previous === undefined) delete process.env.TW_ARTIFACT_ROOT; else process.env.TW_ARTIFACT_ROOT = previous
    await rm(dir, { recursive: true, force: true })
  }
})
