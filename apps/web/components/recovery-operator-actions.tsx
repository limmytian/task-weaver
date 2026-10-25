"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { ExecutionRecoveryView } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { recoveryReviewChecks, recoveryReviewComplete } from "@/lib/recovery-decision";

const blocked = {
  human_required: "Only a human operator can record this decision.",
  write_permission_required: "Current requirement write permission is required.",
  management_permission_required: "Current project management permission is required.",
  evidence_current: "Historical evidence does not currently require revalidation.",
  requirement_closed: "This requirement is closed.",
  no_control: "No recovery control is recorded.",
  already_decided: "A recovery decision is already recorded; inspect the replacement instead of repeating it.",
  replacement_owns_lane: "A replacement owns this lane; inspect its results before deciding.",
} as const;

export function RecoveryOperatorActions({ requirementId, view, refreshing = false }: { requirementId: string; view: ExecutionRecoveryView; refreshing?: boolean }) {
  const utils = trpc.useUtils();
  const [reviewReason, setReviewReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState("");
  const [checks, setChecks] = useState<boolean[]>(recoveryReviewChecks.map(() => false));
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = () => { void utils.requirement.recoveryState.invalidate({ id: requirementId }); void utils.requirement.get.invalidate({ id: requirementId }); };
  const clear = () => { setReviewReason(""); setReviewed(false); setRecoveryReason(""); setChecks(recoveryReviewChecks.map(() => false)); };
  const failed = () => {
    clear();
    setFailure("The decision could not be confirmed. Refresh and reconcile the latest state before reviewing it again. No automatic retry was performed.");
    refresh();
  };
  const revalidate = trpc.requirement.revalidateExecution.useMutation({ retry: false, onSuccess: () => { clear(); refresh(); toast.success("Historical evidence review recorded"); }, onError: failed });
  const recover = trpc.requirement.authorizeRecovery.useMutation({ retry: false, onSuccess: () => { clear(); refresh(); toast.success("Recovery decision recorded", { description: "This does not confirm remote process termination or successful restart." }); }, onError: failed });
  const busy = refreshing || revalidate.isPending || recover.isPending;
  const latest = view.controls[0];
  return <div className="space-y-4 border-t pt-3">
    <h4 className="font-medium">Operator decisions</h4>
    {failure && <p role="alert">{failure}</p>}
    {view.actions.revalidate.allowed ? <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      if (!reviewed || !reviewReason.trim() || busy) return;
      setFailure(null);
      revalidate.mutate({ requirementId, data: { reason: reviewReason.trim(), expectedPlanRevision: view.planRevision } });
    }}>
      <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)} />I inspected historical evidence against the current plan revision {view.planRevision}.</label>
      <Textarea aria-label="Evidence revalidation reason" placeholder="Evidence inspected and conclusions supporting the current plan" maxLength={4000} value={reviewReason} disabled={busy} onChange={event => setReviewReason(event.target.value)} />
      <Button type="submit" variant="outline" disabled={!reviewed || !reviewReason.trim() || busy}>Record evidence revalidation</Button>
    </form> : <p className="text-muted-foreground">Evidence review: {view.actions.revalidate.blockedReason ? blocked[view.actions.revalidate.blockedReason] : "Unavailable"}</p>}
    {view.actions.recover.allowed && latest && view.actions.recover.expectedControlUpdatedAt ? <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      if (!recoveryReviewComplete(recoveryReason, checks) || busy) return;
      setFailure(null);
      recover.mutate({ requirementId, data: { controlId: latest.id, expectedPlanRevision: view.planRevision,
        expectedControlUpdatedAt: new Date(latest.updatedAt), expectedControlPhase: latest.phase, reason: recoveryReason.trim() } });
    }}>
      <p>Authorize fresh recovery only after inspecting outcomes, required inputs and preserved work. This does not complete tasks, resolve Git conflicts or restore the previous run&apos;s authority.</p>
      {recoveryReviewChecks.map((label, index) => <label key={label} className="flex items-start gap-2"><input type="checkbox" checked={checks[index]} disabled={busy} onChange={event => setChecks(current => current.map((value, i) => i === index ? event.target.checked : value))} />{label}</label>)}
      <Textarea aria-label="Manual recovery verification reason" placeholder="Verified external outcomes, input availability and preserved-work handling" maxLength={4000} value={recoveryReason} disabled={busy} onChange={event => setRecoveryReason(event.target.value)} />
      <Button type="submit" variant="outline" disabled={!recoveryReviewComplete(recoveryReason, checks) || busy}>Record recovery authorization</Button>
    </form> : <p className="text-muted-foreground">Manual recovery: {view.actions.recover.blockedReason ? blocked[view.actions.recover.blockedReason] : "Unavailable"}</p>}
  </div>;
}
