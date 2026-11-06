import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinWorkerStatusContent } from '../components/thin-worker-status';

test('worker status preserves offline handoff and treats output as text', () => {
  const html = renderToStaticMarkup(React.createElement(ThinWorkerStatusContent, {
    projectId: 'project-fixture',
    workers: { isLoading: false, data: [{ workerId: 'worker', nodeId: 'node-b', status: 'offline', heartbeatAt: new Date('2026-01-01T00:00:00Z'), activityChangedAt: new Date('2026-01-01T00:00:00Z'), activity: 'cooldown', reason: 'Quota exhausted', retryAt: null }] },
    attempts: { isLoading: false, data: [{ id: 'attempt', taskId: 'task-id', requirementId: 'requirement-id', nodeId: 'node-b', effectiveStatus: 'expired', heartbeatAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T00:02:00Z'), result: { summary: '<script>bad()</script>', outputId: 'output-id' } }] as never },
  }));
  assert.match(html, /Last reported activity/);
  assert.match(html, /cooldown/);
  assert.match(html, /Quota exhausted/);
  assert.match(html, /expired/);
  assert.match(html, /Usage: unknown/);
  assert.match(html, /Inspect the local workspace/);
  assert.match(html, /Shared evidence: output-id/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});
