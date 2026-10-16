"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function HumanDeliverySync({ link, refresh }: {
  link: { id: string; pullRequestUrl: string | null; headCommit?: string | null; pushedCommit?: string | null; externalSyncRevision: number; updatedAt: Date | string };
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [direct, setDirect] = useState(false);
  const [commit, setCommit] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ revision: number; updatedAt: string; requestId: string } | null>(null);
  const sync = trpc.repository.reconcileHumanDelivery.useMutation();
  const edit = () => { setError(null); setAttempt(current => current ? { ...current, requestId: crypto.randomUUID() } : current); };
  return <>
    <Button size="xs" variant="outline" className="mt-2" onClick={() => {
      setUrl(link.pullRequestUrl ?? ""); setDirect(false); setCommit(link.pushedCommit ?? link.headCommit ?? ""); setReason(""); setError(null);
      setAttempt({ revision: link.externalSyncRevision, updatedAt: new Date(link.updatedAt).toISOString(), requestId: crypto.randomUUID() });
      setOpen(true);
    }}>Verify delivery</Button>
    <Dialog open={open} onOpenChange={next => { if (!sync.isPending) setOpen(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify repository delivery</DialogTitle>
          <DialogDescription>Verify a pull request or a commit directly integrated into the target branch. Configured acceptance and integration stages still apply.</DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-sm">Delivery evidence
          <select aria-label="Delivery evidence" className="w-full rounded-md border bg-background p-2" disabled={sync.isPending} value={direct ? "direct" : "pr"} onChange={event => { setDirect(event.target.value === "direct"); edit(); }}>
            <option value="pr">Pull request</option>
            <option value="direct" disabled={Boolean(link.pullRequestUrl)}>Direct integration without a PR</option>
          </select>
        </label>
        {direct ? <label className="space-y-1 text-sm">Delivered commit SHA
          <Input aria-label="Delivered commit SHA" value={commit} disabled={sync.isPending} onChange={event => { setCommit(event.target.value); edit(); }} placeholder="Full commit SHA contained in the configured target branch" />
        </label> : <label className="space-y-1 text-sm">Pull request URL
          <Input aria-label="Pull request URL" value={url} disabled={sync.isPending} onChange={event => { setUrl(event.target.value); edit(); }} placeholder="https://github.com/owner/repository/pull/123" />
        </label>}
        <label className="space-y-1 text-sm">Reason
          <Input aria-label="Reconciliation reason" value={reason} disabled={sync.isPending} onChange={event => { setReason(event.target.value); edit(); }} placeholder="Explain why this delivery needs synchronization" />
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={sync.isPending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={sync.isPending || !attempt || (direct ? !/^[a-f0-9]{40,64}$/.test(commit.trim()) : !url.trim()) || reason.trim().length < 3} onClick={async () => {
            if (!attempt) return;
            try {
              const result = await sync.mutateAsync({ linkId: link.id, data: { ...(direct ? { commit: commit.trim() } : { pullRequestUrl: url.trim() }), reason: reason.trim(), expectedRevision: attempt.revision, expectedUpdatedAt: new Date(attempt.updatedAt), idempotencyKey: attempt.requestId } });
              if (!result.ok) throw new Error(result.error);
              await refresh(); setOpen(false);
              toast.success(result.link.deliveryStatus === "merged" ? "Verified merge recorded. The requirement can complete once its tasks and configured stages are satisfied." : "PR state synchronized. The provider has not merged it.");
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "Synchronization failed. Retry with the same form or reopen it after refreshing the delivery.");
              await refresh();
            }
          }}>{sync.isPending ? "Verifying…" : "Verify and synchronize"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
