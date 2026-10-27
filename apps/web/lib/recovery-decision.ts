import type { ExecutionRecoveryView } from "@task-weaver/contracts";

export function recoveryDecisionKey(view: ExecutionRecoveryView): string {
  const latest = view.controls[0];
  return JSON.stringify([view.planRevision, view.evidenceNeedsReview, latest?.id, latest?.updatedAt, latest?.phase,
    view.actions.revalidate.allowed, view.actions.revalidate.blockedReason, view.actions.recover.allowed, view.actions.recover.blockedReason]);
}
export const recoveryReviewChecks = [
  "I verified the outcome of uncertain external operations; this decision will not blindly replay them.",
  "Required durable inputs are available, and irreplaceable local-only inputs are handled.",
  "Preserved files and branch conflicts were inspected; agents must reconcile them before continuing.",
  "I understand this decision does not prove the old remote process has terminated or preserve all local progress.",
] as const;
export function recoveryReviewComplete(reason: string, checks: boolean[]): boolean {
  return reason.trim().length > 0 && reason.trim().length <= 4000 && checks.length === recoveryReviewChecks.length && checks.every(Boolean);
}
