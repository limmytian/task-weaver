import { evidenceNodeDemandSchema, evidenceLimits } from '@task-weaver/contracts';
import { EvidenceArtifactError } from './evidence-artifact.js';
import { produceEvidence } from './evidence-producer.js';

/** Evidence transfers run independently of execution and heartbeat scheduling. */
export function createEvidenceCoordinator(options: {
  daemonId: string; nodeId: string; root: string;
  get: (path: string, signal: AbortSignal) => Promise<{ items: unknown[] }>;
  post: (path: string, body: unknown, signal: AbortSignal) => Promise<any>;
}) {
  const active = new Map<string, AbortController>();
  let closed = false, polling = false;
  const tick = async () => {
    if (closed || polling || active.size >= evidenceLimits.nodeConcurrency) return;
    polling = true;
    try {
      const response = await options.get(`/api/v1/evidence/demands/${options.daemonId}`, AbortSignal.timeout(2500));
      for (const raw of response.items.slice(0, 32)) {
        if (closed || active.size >= evidenceLimits.nodeConcurrency) break;
        const parsed = evidenceNodeDemandSchema.safeParse(raw);
        if (!parsed.success) continue;
        const demand = parsed.data;
        if (demand.daemonId !== options.daemonId || demand.nodeId !== options.nodeId || Date.parse(demand.expiresAt) <= Date.now() || active.has(demand.requestId)) continue;
        const controller = new AbortController(); active.set(demand.requestId, controller);
        void produceEvidence(demand, { nodeId: options.nodeId, root: options.root, signal: controller.signal,
          claim: (item, signature, signal) => options.post(`/api/v1/evidence/${item.requestId}/claim`, { daemonId: options.daemonId, signature }, signal),
          push: async (item, sequence, bytes, signal) => { await options.post(`/api/v1/evidence/${item.requestId}/chunk`, { daemonId: options.daemonId, sequence, contentBase64: Buffer.from(bytes).toString('base64') }, signal); },
          finish: async (item, sequence, signal) => { await options.post(`/api/v1/evidence/${item.requestId}/finish`, { daemonId: options.daemonId, sequence }, signal); },
        }).catch(async error => {
          if (closed || controller.signal.aborted || !(error instanceof EvidenceArtifactError)) return;
          const state = error.state;
          try { await options.post(`/api/v1/evidence/${demand.requestId}/fail`, { daemonId: options.daemonId, state }, AbortSignal.timeout(2500)); } catch { /* The request may have expired or been cancelled. */ }
        }).finally(() => active.delete(demand.requestId));
      }
    } catch { /* No request bodies, file paths or credentials enter daemon logs. */ }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void tick(); }, 1000); timer.unref();
  void tick();
  return { tick, close: () => { closed = true; clearInterval(timer); for (const controller of active.values()) controller.abort(); active.clear(); } };
}
