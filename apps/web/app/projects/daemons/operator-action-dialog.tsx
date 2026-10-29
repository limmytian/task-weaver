"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorAction } from "./daemon-view-model";

export function OperatorActionDialog({
  action,
  reason,
  onReasonChange,
  onOpenChange,
  onConfirm,
  pending,
}: {
  action: OperatorAction | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const title = action?.kind === "daemon" || action?.kind === "pipeline"
    ? `${action.action[0]!.toUpperCase()}${action.action.slice(1)} ${action.kind === "daemon" ? action.daemonName : action.pipelineName}?`
    : action?.kind === "retry"
      ? `Retry ${action.repositoryName}?`
      : action
        ? `Hand off ${action.repositoryName}?`
        : "Confirm operator action";
  const description = action?.kind === "daemon" || action?.kind === "pipeline"
    ? action.action === "resume"
      ? "This immediately re-enables acquisition for the daemon. The reason is stored in the daemon activity log."
      : action.action === "drain"
        ? "New acquisition stops immediately. Active workers are allowed to reach a safe boundary before the daemon becomes drained."
        : "New acquisition stops immediately. Active workers continue without interruption until they finish."
    : action?.kind === "retry"
      ? `This reopens only this repository delivery, moves the Requirement to the ${action.retryPhase ?? "target"} phase, and wakes the ${action.retryRole ?? "matching"} daemon queue.`
      : "The failed delivery remains durable, automatic retries are disabled, and the operator reason becomes the remediation handoff.";

  return (
    <Dialog open={Boolean(action)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="operator-action-reason" className="text-sm font-medium">Audit reason</label>
          <Textarea
            id="operator-action-reason"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder="Explain why this action is safe and necessary"
            maxLength={1000}
            aria-invalid={reason.trim().length > 0 && reason.trim().length < 3}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">Stored with the durable state transition and visible in activity history.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button
            onClick={onConfirm}
            disabled={pending || reason.trim().length < 3}
            aria-busy={pending}
          >
            {pending ? "Applying…" : "Confirm action"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
