import { consoleDemandSchema, type ConsoleTarget } from '@task-weaver/contracts';
import { WorkerConsoleBuffer } from './worker-console-buffer.js';

/** Uses the supervisor's existing control tick; observation has no process-control authority. */
export function createWorkerConsoleObserver(options: {
  target: ConsoleTarget; daemonId: string; buffer: WorkerConsoleBuffer;
  get: (path: string) => Promise<{ items: unknown[] }>;
  post: (path: string, body: unknown) => Promise<unknown>;
  now?: () => number; signal?: AbortSignal;
}) {
  let closed = false; let polling = false; let offset = 0;
  const close = () => { closed = true; options.buffer.close(); options.signal?.removeEventListener('abort', close); };
  if (options.signal?.aborted) close(); else options.signal?.addEventListener('abort', close, { once: true });
  const tick = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const { items } = await options.get(`/api/v1/worker-console/demands/${options.daemonId}`);
      if (closed) return;
      let count = 0;
      const ordered = [...items.slice(offset), ...items.slice(0, offset)];
      offset = items.length ? (offset + 4) % items.length : 0;
      for (const raw of ordered) {
        const result = consoleDemandSchema.safeParse(raw); if (!result.success) continue;
        const d = result.data; const target = options.target;
        if (d.runId !== target.runId || d.requirementId !== target.requirementId || d.taskId !== target.taskId || d.workerIndex !== target.workerIndex || d.leaseGeneration !== target.leaseGeneration || d.expiresAt <= (options.now ?? Date.now)() || closed) continue;
        if (!/^[a-z0-9_-]{1,32}\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/.test(d.id) || count++ >= 4) continue;
        const batch = options.buffer.snapshot(d.after, d.revision);
        await options.post(`/api/v1/worker-console/${d.id.split('.')[0]}/${d.id}/response`, { daemonId: options.daemonId, batch });
      }
    } catch { /* No bodies, errors or credentials may enter operational logs. */ }
    finally { polling = false; }
  };
  return { tick, close };
}
