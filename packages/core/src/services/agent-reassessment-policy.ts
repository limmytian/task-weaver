/** A grant is an explicit ceiling, not an execution lease or proof of evidence. */
export type ReassessmentGrant = {
  projectId: string;
  requirementId: string | null;
  agentId: string;
  operations: readonly ('revalidate_evidence' | 'assess_interrupted_execution')[];
  expiresAt: Date;
  revokedAt: Date | null;
};

export type Reassessment = {
  projectId: string;
  requirementId: string;
  agentId: string;
  operation: 'revalidate_evidence';
  expectedRevision: number;
  decision: 'accept' | 'escalate';
  evidence: readonly { reference: string; rationale: string }[];
  rationale: string;
  inputsAvailable: boolean;
  uncertainExternalEffects: boolean;
};

/**
 * This predicate must be evaluated inside the transaction that records and applies
 * a decision, after locking the requirement and grant and checking caller identity.
 * It does not confer authority to recover or resume an interrupted execution.
 */
export function reassessmentDisposition(grant: ReassessmentGrant | null, assessment: Reassessment, currentRevision: number, now: Date) {
  if (!grant || grant.revokedAt || grant.expiresAt <= now || grant.projectId !== assessment.projectId
    || (grant.requirementId !== null && grant.requirementId !== assessment.requirementId)
    || grant.agentId !== assessment.agentId || !grant.operations.includes(assessment.operation)) return 'unauthorized' as const;
  if (assessment.expectedRevision !== currentRevision) return 'stale' as const;
  if (!assessment.rationale.trim() || !assessment.evidence.length
    || assessment.evidence.some(item => !item.reference.trim() || !item.rationale.trim())
    || !assessment.inputsAvailable || assessment.uncertainExternalEffects || assessment.decision === 'escalate') return 'escalate' as const;
  return 'accept' as const;
}
