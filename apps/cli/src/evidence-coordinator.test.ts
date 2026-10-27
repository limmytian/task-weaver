import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceCoordinator } from './evidence-coordinator';

test('slow evidence polling does not block the caller or overlap another poll', async () => {
  let calls = 0; let finish: ((value: { items: unknown[] }) => void) | undefined;
  const coordinator = createEvidenceCoordinator({ daemonId: 'daemon', nodeId: 'node', root: '/tmp', get: async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, post: async () => ({}) });
  await coordinator.tick();
  assert.equal(calls, 1);
  let heartbeat = false;
  await new Promise<void>(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 10));
  assert.equal(heartbeat, true);
  finish?.({ items: [] }); coordinator.close();
});
