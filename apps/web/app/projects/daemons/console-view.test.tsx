import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appendConsoleFrames, visibleConsoleText } from './console-view';
import { ConsoleOutput } from './worker-console';
import { consoleLimits, type ConsoleFrame } from '@task-weaver/contracts';

test('console renders untrusted output as literal text', () => {
  const html = renderToStaticMarkup(<ConsoleOutput text={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />);
  assert(!html.includes('<script>')); assert(!html.includes('<img'));
  assert(html.includes('&lt;script&gt;'));
});
test('browser buffer bounds bytes and frames; copy text uses the selected stream', () => {
  const frames: ConsoleFrame[] = Array.from({ length: 1100 }, (_, i) => ({ sequence: i + 1, stream: i % 2 ? 'stderr' : 'stdout', text: '你'.repeat(100) }));
  const bounded = appendConsoleFrames([], frames);
  assert(bounded.dropped); assert(bounded.frames.length <= consoleLimits.frames);
  assert(bounded.frames.reduce((n, f) => n + Buffer.byteLength(f.text), 0) <= consoleLimits.ringBytes);
  const filtered = visibleConsoleText(bounded.frames, 'stderr');
  assert(filtered.includes('[stderr]')); assert(!filtered.includes('[stdout]'));
});
