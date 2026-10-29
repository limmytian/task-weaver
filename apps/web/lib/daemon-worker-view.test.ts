import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkerCard } from '../app/projects/daemons/worker-card';

test('worker view keeps uncertain lease and preserved recovery visible beside a completed roadmap', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const html = renderToStaticMarkup(React.createElement(WorkerCard, {
    now, onShowTimeline: () => {},
    worker: {
      index: 0, status: 'running', requirementId: 'requirement-fixture',
      requirement: { id: 'requirement-fixture', title: 'Preserved work', status: 'in_progress' },
      leaseHealthy: false, leaseHeartbeatFailures: 2, lastLeaseError: 'Lease renewal unavailable',
      claim: { expiresAt: '2026-01-01T11:59:00Z', generation: 4 },
      progress: { phase: 'recovering', workspaceState: 'dirty', recoveryDisposition: 'manual', handoffSummary: 'Inspect preserved files before retrying' },
      roadmap: [{ id: 'task-fixture', title: 'Completed task', status: 'done' }],
    },
  }));
  assert.match(html, /Lease renewal unavailable/);
  assert.match(html, /lease unhealthy/);
  assert.match(html, /Inspect preserved files before retrying/);
  assert.match(html, /dirty/);
  assert.match(html, /Completed task/);
  assert.doesNotMatch(html, /idle · ready for work/);
});
