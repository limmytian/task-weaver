import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkerConsoleCoordinator } from './worker-console-coordinator.js';
import { createWorkerConsoleObserver } from './worker-console-observer.js';
import { WorkerConsoleBuffer } from './worker-console-buffer.js';

const target = (index: number) => ({ requirementId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), workerIndex: index, leaseGeneration: 1 });
const demand = (t: ReturnType<typeof target>, now: number) => ({ ...t, id: `local.${randomUUID()}.${randomUUID()}`, revision: 0, after: 0, expiresAt: now + 10_000 });

test('four overlapping or staggered worker ticks share one fresh daemon read without demand uploads', async () => {
  let legacyReads = 0, reads = 0, uploads = 0, now = 1000;
  const old = Array.from({ length: 4 }, (_, i) => createWorkerConsoleObserver({ daemonId: randomUUID(), target: target(i),
    buffer: new WorkerConsoleBuffer('codex', () => []), get: async () => { legacyReads++; return { items: [] }; }, post: async () => {} }));
  await Promise.all(old.map(worker => worker.tick())); old.forEach(worker => worker.close());
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), now: () => now,
    get: async () => { reads++; return { items: [] }; }, post: async () => { uploads++; } });
  const workers = Array.from({ length: 4 }, (_, i) => coordinator.observe({ target: target(i), buffer: new WorkerConsoleBuffer('codex', () => []) }));
  await Promise.all(workers.map(worker => worker.tick()));
  for (const worker of workers) { now += 100; await worker.tick(); }
  assert.equal(legacyReads, 4); assert.equal(reads, 1); assert.equal(uploads, 0);
  now += 1000; await coordinator.tick(); assert.equal(reads, 2);
  workers.forEach(worker => worker.close()); now += 1000; await coordinator.tick(); assert.equal(reads, 2);
});

test('dispatch is bounded and fair,keeps exact run fences,and stops after the last observer', async () => {
  let now = 1000;
  const targets = Array.from({ length: 4 }, (_, i) => target(i));
  const demands = Array.from({ length: 8 }, () => demand(targets[0]!, now));
  let items: unknown[] = demands;
  const posted: string[] = [];
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), now: () => now,
    get: async () => ({ items }), post: async path => { posted.push(path); } });
  const abort = new AbortController();
  const observers = targets.map(t => coordinator.observe({ target: t, buffer: new WorkerConsoleBuffer('codex', () => []), signal: abort.signal }));
  await coordinator.tick(); assert.equal(posted.length, 4);
  now += 1000; await coordinator.tick(); assert.equal(new Set(posted).size, 8);
  items = [{ ...demands[0], runId: randomUUID() }, { ...demands[0], leaseGeneration: 2 }, { ...demands[0], expiresAt: now }];
  now += 1000; await coordinator.tick(); assert.equal(posted.length, 8);
  items = [demands[0]]; abort.abort(); now += 1000; await coordinator.tick(); assert.equal(posted.length, 8);
  observers.forEach(observer => observer.close()); coordinator.close();
});

test('closing during a slow fetch discards metadata;new runs never reuse fetched authority', async () => {
  let finish!: (value: { items: unknown[] }) => void;
  let reads = 0, uploads = 0, now = 1000;
  const t = target(0);
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), now: () => now,
    get: () => { reads++; return new Promise(resolve => { finish = resolve; }); }, post: async () => { uploads++; } });
  const first = coordinator.observe({ target: t, buffer: new WorkerConsoleBuffer('codex', () => []) });
  const pending = first.tick(); first.close(); finish({ items: [demand(t, now)] }); await pending;
  assert.equal(uploads, 0);
  const second = coordinator.observe({ target: { ...t, runId: randomUUID() }, buffer: new WorkerConsoleBuffer('codex', () => []) });
  now += 1000; const next = second.tick(); finish({ items: [demand(t, now)] }); await next;
  assert.equal(reads, 2); assert.equal(uploads, 0); second.close();
});

test('failed observation transport remains independent from worker execution', async () => {
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(),
    get: async () => { throw Error('fixture failure'); }, post: async () => { throw Error('fixture failure'); } });
  const observer = coordinator.observe({ target: target(0), buffer: new WorkerConsoleBuffer('codex', () => []) });
  await assert.doesNotReject(observer.tick()); observer.close(); coordinator.close();
});


test('one slow viewer does not hold fresh metadata or uploads for another worker', async () => {
  const a = target(0), b = target(1); let now = 1000, reads = 0, bPosts = 0;
  let release!: () => void, firstB!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { firstB = resolve; });
  const da = demand(a, now), db = demand(b, now);
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), now: () => now,
    get: async () => { reads++; return { items: [da, db] }; },
    post: async path => { if (path.includes(da.id)) await blocked; else { bPosts++; firstB(); } } });
  const observers = [a, b].map(t => coordinator.observe({ target: t, buffer: new WorkerConsoleBuffer('codex', () => []) }));
  const first = coordinator.tick(); await ready; now += 1000;
  await coordinator.tick(); assert.equal(reads, 2); assert.equal(bPosts, 2);
  release(); await first; observers.forEach(observer => observer.close()); coordinator.close();
});


test('coordinated observation failure does not interrupt a real synthetic worker process', async () => {
  const { runCommand } = await import('./async-command.js');
  const t = target(0), buffer = new WorkerConsoleBuffer('codex', () => []);
  let failed = 0;
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), get: async () => ({ items: [demand(t, Date.now())] }),
    post: async () => { failed++; throw Error('fixture transport failure'); } });
  const observer = coordinator.observe({ target: t, buffer });
  const result = await runCommand(process.execPath, ['-e', `let n=0;const t=setInterval(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'synthetic '+(++n)}}));if(n===5)clearInterval(t)},20)`],
    { maxOutputBytes: 0, timeoutMs: 2000, onStdout: chunk => buffer.push('stdout', chunk) });
  assert.equal(result.ok, true); assert.ok(failed > 0);
  assert.ok(buffer.snapshot(0, 0).frames.some(frame => frame.text.includes('synthetic 5')));
  observer.close(); coordinator.close();
});


test('one metadata timer serves all workers and stops when the last worker leaves', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let reads = 0;
  const coordinator = createWorkerConsoleCoordinator({ daemonId: randomUUID(), get: async () => { reads++; return { items: [] }; }, post: async () => {} });
  const observers = Array.from({ length: 4 }, (_, index) => coordinator.observe({ target: target(index), buffer: new WorkerConsoleBuffer('codex', () => []) }));
  await coordinator.tick(); assert.equal(reads, 1);
  t.mock.timers.tick(1000); await coordinator.tick(); assert.equal(reads, 2);
  observers.slice(0, 3).forEach(observer => observer.close());
  t.mock.timers.tick(1000); await coordinator.tick(); assert.equal(reads, 3);
  observers[3]!.close(); t.mock.timers.tick(2000); await coordinator.tick(); assert.equal(reads, 3);
  coordinator.close(); t.mock.timers.reset();
});
