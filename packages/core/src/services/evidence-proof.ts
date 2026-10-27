import { createPublicKey, verify } from 'node:crypto';
import { evidenceNodeDemandSchema, evidenceRegistrationPayload, evidenceDemandPayload, type EvidenceNodeDemand } from '@task-weaver/contracts';

/** Canonical bytes are domain-separated from task execution and other signatures. */
export function evidenceProofPayload(raw: EvidenceNodeDemand): Buffer {
  return Buffer.from(evidenceDemandPayload(raw), 'utf8');
}

/** The public key is the output's trusted registration binding, not request data. */
export function verifyEvidenceNodeProof(demand: EvidenceNodeDemand, registeredPublicKey: string, signature: string, now = Date.now()): boolean {
  try {
    const parsed = evidenceNodeDemandSchema.parse(demand);
    const expiry = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 30_000) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(registeredPublicKey) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
    const encoded = Buffer.from(registeredPublicKey, 'base64');
    const proof = Buffer.from(signature, 'base64');
    if (encoded.length !== 44 || proof.length !== 64 || encoded.toString('base64') !== registeredPublicKey || proof.toString('base64') !== signature) return false;
    const key = createPublicKey({ key: encoded, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, evidenceProofPayload(parsed), key, proof);
  } catch { return false; }
}

/** Registration proofs are checked before a key is bound to an immutable output. */
export function verifyEvidenceRegistration(input: { requirementId: string; nodeId: string; relativePath: string; sizeBytes: number; sha256: string }, registeredPublicKey: string, signature: string): boolean {
  try {
    const encoded = Buffer.from(registeredPublicKey, 'base64');
    const proof = Buffer.from(signature, 'base64');
    if (encoded.length !== 44 || proof.length !== 64 || encoded.toString('base64') !== registeredPublicKey || proof.toString('base64') !== signature) return false;
    const key = createPublicKey({ key: encoded, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(evidenceRegistrationPayload(input), 'utf8'), key, proof);
  } catch { return false; }
}
