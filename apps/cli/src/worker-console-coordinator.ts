import { consoleDemandSchema, type ConsoleTarget } from '@task-weaver/contracts';
import { WorkerConsoleBuffer } from './worker-console-buffer.js';

type Observer = { target: ConsoleTarget; buffer: WorkerConsoleBuffer; closed: boolean; polling: boolean; offset: number; close: () => void };
const key = (target: ConsoleTarget) => [target.requirementId, target.taskId, target.runId, target.workerIndex, target.leaseGeneration].join(':');

/** One daemon tick dispatches fresh metadata to current runs. No response or authority is cached. */
export function createWorkerConsoleCoordinator(options: {
  daemonId: string; get: (path: string) => Promise<{ items: unknown[] }>;
  post: (path: string, body: unknown) => Promise<unknown>; now?: () => number;
  minimumIntervalMs?: number;
}) {
  const observers = new Map<string, Observer>();
  const now = options.now ?? Date.now;
  let closed = false, lastPoll = -Infinity;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (scheduled = false): Promise<void> => {
    if (closed || !observers.size) return Promise.resolve();
    if (pending) return pending;
    if (!scheduled && now() - lastPoll < (options.minimumIntervalMs ?? 1000)) return Promise.resolve();
    lastPoll = now();
    const operation = (async () => {
      try {
        const { items } = await options.get(`/api/v1/worker-console/demands/${options.daemonId}`);
        if (closed) return;
        // Release metadata admission before uploads: a slow viewer cannot stall another worker's next poll.
        pending = undefined;
        await Promise.all([...observers.values()].map(async observer => {
          if (observer.closed || observer.polling) return;
          observer.polling = true;
          try {
            const ordered = [...items.slice(observer.offset), ...items.slice(0, observer.offset)];
            observer.offset = items.length ? (observer.offset + 4) % items.length : 0;
            let dispatched = 0;
            for (const raw of ordered) {
              if (closed || observer.closed || dispatched >= 4) break;
              const parsed = consoleDemandSchema.safeParse(raw);
              if (!parsed.success) continue;
              const demand = parsed.data;
              if (key(demand) !== key(observer.target) || demand.expiresAt <= now()
                || !/^[a-z0-9_-]{1,32}\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/.test(demand.id)) continue;
              dispatched++;
              try {
                const batch = observer.buffer.snapshot(demand.after, demand.revision);
                if (observer.closed || closed || demand.expiresAt <= now()) continue;
                await options.post(`/api/v1/worker-console/${demand.id.split('.')[0]}/${demand.id}/response`, { daemonId: options.daemonId, batch });
              } catch { /* A viewer failure must not affect another observer or worker execution. */ }
            }
          } finally { observer.polling = false; }
        }));
      } catch { /* Never log observation bodies, transport errors or credentials. */ }
    })().finally(() => { if (pending === operation) pending = undefined; });
    pending = operation;
    return operation;
  };
  const observe = (input: { target: ConsoleTarget; buffer: WorkerConsoleBuffer; signal?: AbortSignal }) => {
    const targetKey = key(input.target);
    observers.get(targetKey)?.close();
    const observer: Observer = { target: input.target, buffer: input.buffer, closed: false, polling: false, offset: 0, close: () => {
      if (observer.closed) return;
      observer.closed = true; observer.buffer.close();
      if (observers.get(targetKey) === observer) observers.delete(targetKey);
      if (!observers.size) { lastPoll = -Infinity; clearInterval(timer); timer = undefined; }
      input.signal?.removeEventListener('abort', observer.close);
    } };
    if (closed || input.signal?.aborted) observer.close();
    else {
      observers.set(targetKey, observer); input.signal?.addEventListener('abort', observer.close, { once: true });
      if (!timer) {
        timer = setInterval(() => { void tick(true); }, 1000); timer.unref();
        void tick(true);
      }
    }
    return { tick: () => tick(), close: observer.close };
  };
  return { tick: () => tick(), observe, close: () => { closed = true; for (const observer of [...observers.values()]) observer.close(); } };
}
