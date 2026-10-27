import { evidenceLimits, evidenceNodeDemandSchema, type EvidenceNodeDemand } from '@task-weaver/contracts';
import { openVerifiedEvidence } from './evidence-artifact.js';
import { signEvidenceDemand } from './evidence-node-key.js';

/** Authenticated transport callbacks are provided by the daemon supervisor. */
export async function produceEvidence(demandInput: EvidenceNodeDemand, options: {
  nodeId: string;
  root: string;
  signal?: AbortSignal;
  claim: (demand: EvidenceNodeDemand, signature: string, signal: AbortSignal) => Promise<{ demand: EvidenceNodeDemand; relativePath: string }>;
  push: (demand: EvidenceNodeDemand, sequence: number, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  finish: (demand: EvidenceNodeDemand, sequence: number, signal: AbortSignal) => Promise<void>;
}) {
  const demand = evidenceNodeDemandSchema.parse(demandInput);
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(evidenceLimits.requestDurationMs, Date.parse(demand.expiresAt) - Date.now())));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const signature = signEvidenceDemand(demand, options.nodeId);
  const accepted = await options.claim(demand, signature, signal);
  // Never follow a server response for a different request or immutable identity.
  const verified = evidenceNodeDemandSchema.parse(accepted.demand);
  if (JSON.stringify(verified) !== JSON.stringify(demand)) throw new Error('Evidence demand changed during authorization');
  const snapshot = await openVerifiedEvidence(options.root, { relativePath: accepted.relativePath, sizeBytes: demand.sizeBytes, sha256: demand.sha256 }, signal);
  try {
    let sequence = 0;
    for await (const chunk of snapshot.createReadStream()) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length; offset += evidenceLimits.chunkBytes) {
        signal.throwIfAborted();
        await options.push(demand, sequence++, bytes.subarray(offset, offset + evidenceLimits.chunkBytes), signal);
      }
    }
    signal.throwIfAborted();
    await options.finish(demand, sequence, signal);
  } finally { await snapshot.close(); }
}
