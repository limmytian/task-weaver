import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerConsoleBuffer } from './worker-console-buffer.js';
import { consoleLimits, consoleBatchSchema } from '@task-weaver/contracts';

test('UTF-8, split known secrets and terminal sequences are handled before retention', () => {
  const buffer = new WorkerConsoleBuffer('codex', () => ['private-secret']);
  const bytes = Buffer.from('hello你 private-secret \x1b[31m<html>\x1b[0m\n');
  for (const byte of bytes) buffer.push('stderr', Buffer.from([byte]));
  const output = buffer.snapshot(0, 0).frames.map(f => f.text).join('');
  assert.equal(output, 'hello你 [redacted] <html>\n');
  assert(!JSON.stringify(buffer.snapshot(0, 0)).includes('private-secret'));
});
test('structured stdout allowlists output and omits reasoning, prompts and unknown events', () => {
  const buffer = new WorkerConsoleBuffer('codex', () => []);
  for (const item of [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'agent_message', text: 'public' }, { type: 'command_execution', command: 'PRIVATE', aggregated_output: 'result' }]) buffer.push('stdout', Buffer.from(JSON.stringify({ type: 'item.completed', item }) + '\n'));
  assert.equal(buffer.snapshot(0, 0).frames.map(f => f.text).join(''), 'public\nresult');
  buffer.push('stdout', Buffer.from('x'.repeat(100_000) + '\n'));
  assert(buffer.snapshot(0, 0).unavailable);
});
test('burst, age, batch and close boundaries remain bounded and disclose loss', () => {
  let now = 100_000;
  const buffer = new WorkerConsoleBuffer('codex', () => [], () => now);
  for (let i = 0; i < 200; i++) buffer.push('stderr', Buffer.from('你'.repeat(4096)));
  const batch = buffer.snapshot(0, 0);
  assert(batch.truncated); assert(consoleBatchSchema.safeParse(batch).success);
  assert(batch.frames.reduce((n, f) => n + Buffer.byteLength(f.text), 0) <= consoleLimits.batchBytes);
  now += consoleLimits.ringAgeMs + 1;
  assert.equal(buffer.snapshot(0, 0).frames.length, 0);
  buffer.close(); buffer.push('stderr', Buffer.from('no retention'));
  assert.equal(buffer.snapshot(0, 0).frames.length, 0);
});
test('unsupported stdout and incomplete secret prefixes are never exposed', () => {
  const unsupported = new WorkerConsoleBuffer('other', () => []);
  unsupported.push('stdout', Buffer.from('unknown private record'));
  unsupported.push('stderr', Buffer.from('unknown private record'));
  assert.equal(unsupported.snapshot(0, 0).frames.length, 0); assert(unsupported.snapshot(0, 0).unavailable);
  const buffer = new WorkerConsoleBuffer('codex', () => ['abc-secret']);
  buffer.push('stderr', Buffer.from('ok abc-'));
  assert.equal(buffer.snapshot(0, 0).frames.map(f => f.text).join(''), 'ok ');
  buffer.close();
});
