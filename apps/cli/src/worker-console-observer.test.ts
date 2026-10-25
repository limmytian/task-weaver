import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkerConsoleObserver } from './worker-console-observer.js';
import { WorkerConsoleBuffer } from './worker-console-buffer.js';

test('no demand means zero body uploads; current tuple and deadlines fence producers', async () => {
  const target = { requirementId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), workerIndex: 1, leaseGeneration: 2 };
  const buffer = new WorkerConsoleBuffer('codex', () => []); buffer.push('stderr', Buffer.from('retained locally'));
  let items: unknown[] = []; const calls: unknown[] = [];
  const observer = createWorkerConsoleObserver({ target, daemonId: randomUUID(), buffer, get: async () => ({ items }), post: async (_path, body) => { calls.push(body); } });
  await observer.tick(); assert.equal(calls.length, 0);
  const demand = { ...target, id: `local.${randomUUID()}.${randomUUID()}`, revision: 0, after: 0, expiresAt: Date.now() + 10_000 };
  items = [{ ...demand, runId: randomUUID() }, { ...demand, workerIndex: 0 }, { ...demand, leaseGeneration: 1 }, { ...demand, expiresAt: 1 }];
  await observer.tick(); assert.equal(calls.length, 0);
  items = [demand]; await observer.tick(); assert.equal(calls.length, 1);
  items = []; await observer.tick(); assert.equal(calls.length, 1);
  observer.close(); items = [demand]; await observer.tick(); assert.equal(calls.length, 1);
});
test('a slow or failed observation cannot throw into execution and ticks do not overlap', async () => {
  let finish!: (value: { items: unknown[] }) => void; let reads = 0;
  const observer = createWorkerConsoleObserver({ target: { requirementId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), workerIndex: 0, leaseGeneration: 1 }, daemonId: randomUUID(), buffer: new WorkerConsoleBuffer('codex', () => []), get: () => { reads++; return new Promise(resolve => { finish = resolve; }); }, post: async () => { throw new Error('do not log body'); } });
  const tick = observer.tick(); await observer.tick(); assert.equal(reads, 1);
  observer.close(); finish({ items: [] }); await tick;
});

test('two worker rings and two viewers stay isolated; cancellation removes only its demand', async () => {
  const requirementId = randomUUID();
  const a = { requirementId, taskId: randomUUID(), runId: randomUUID(), workerIndex: 0, leaseGeneration: 1 };
  const b = { ...a, taskId: randomUUID(), runId: randomUUID(), workerIndex: 1 };
  const make = (target: typeof a, text: string) => {
    const buffer = new WorkerConsoleBuffer('codex', () => []); buffer.push('stderr', Buffer.from(text));
    return { target, buffer };
  };
  const demand = (target: typeof a) => ({ ...target, id: `local.${randomUUID()}.${randomUUID()}`, revision: 0, after: 0, expiresAt: Date.now() + 10_000 });
  const a1 = demand(a), a2 = demand(a), b1 = demand(b);
  let items = [a1, a2, b1]; const uploads: Array<{ path: string; body: any }> = [];
  const observers = [make(a, 'worker A'), make(b, 'worker B')].map(run => createWorkerConsoleObserver({ ...run, daemonId: randomUUID(), get: async () => ({ items }), post: async (path, body) => { uploads.push({ path, body }); } }));
  await Promise.all(observers.map(o => o.tick()));
  assert.equal(uploads.length, 3);
  for (const upload of uploads) assert.equal(upload.body.batch.frames[0].text, upload.path.includes(b1.id) ? 'worker B' : 'worker A');
  items = [a2]; uploads.length = 0;
  await Promise.all(observers.map(o => o.tick())); assert.equal(uploads.length, 1); assert(uploads[0]!.path.includes(a2.id));
  items = []; await Promise.all(observers.map(o => o.tick())); assert.equal(uploads.length, 1);
  observers.forEach(o => o.close());
});

test('observation transport failures do not affect a real managed process', async () => {
  const { runCommand } = await import('./async-command.js');
  const target = { requirementId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), workerIndex: 0, leaseGeneration: 1 };
  const buffer = new WorkerConsoleBuffer('codex', () => []);
  const demand = { ...target, id: `local.${randomUUID()}.${randomUUID()}`, revision: 0, after: 0, expiresAt: Date.now() + 10_000 };
  let failed = 0;
  const observer = createWorkerConsoleObserver({ target, daemonId: randomUUID(), buffer, get: async () => ({ items: [demand] }), post: async () => { failed++; throw new Error('fixture network unavailable'); } });
  const result = await runCommand(process.execPath, ['-e', `let n=0;const t=setInterval(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'diagnostic '+(++n)}}));if(n===5)clearInterval(t)},20)`], { maxOutputBytes: 0, timeoutMs: 2000, onStdout: chunk => { buffer.push('stdout', chunk); void observer.tick(); } });
  await observer.tick();
  assert(result.ok); assert(failed > 0); assert(buffer.snapshot(0, 0).frames.some(f => f.text.includes('diagnostic 5')));
  observer.close();
});
