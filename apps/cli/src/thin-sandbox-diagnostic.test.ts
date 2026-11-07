import test from 'node:test'
import assert from 'node:assert/strict'
import { ThinSandboxDiagnostic } from './thin-sandbox-diagnostic.js'

test('reports bounded sandbox hints without retaining command output', () => {
  const collector = new ThinSandboxDiagnostic()
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'bwrap: loopback: Failed RTM_NEWADDR: No child process\nsecret-value' } }) + '\n'
  collector.push(Buffer.from(line.slice(0, 40)))
  collector.push(Buffer.from(line.slice(40)))
  assert.match(collector.finish() ?? '', /possible sandbox initialization failure/)
  assert.doesNotMatch(JSON.stringify(collector), /secret-value/)
})

test('ignores model text, successful commands and oversized events', () => {
  const collector = new ThinSandboxDiagnostic()
  const output = 'bwrap: setting up uid map: Permission denied'
  collector.push(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }) + '\n'))
  collector.push(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: output } }) + '\n'))
  collector.push(Buffer.from('x'.repeat(70000) + '\n'))
  assert.equal(collector.finish(), null)
})
