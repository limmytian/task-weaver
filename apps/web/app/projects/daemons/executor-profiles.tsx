"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ExecutorTool } from "@task-weaver/core";
import { Badge } from "@/components/ui/badge";

export function ExecutorProfiles() {
  const daemonQuery = trpc.daemon.executorDaemons.useQuery(undefined, { refetchInterval: 30_000 });
  const daemons = daemonQuery.data ?? [];
  const [daemonId, setDaemonId] = useState("");
  const [retry, setRetry] = useState<{ tool: ExecutorTool; version: number } | null>(null);
  const [reason, setReason] = useState("");
  const selected = daemonId || daemons[0]?.id || "";
  const profiles = trpc.daemon.executorProfiles.useQuery({ daemonId: selected }, { enabled: Boolean(selected), refetchInterval: 30_000 });
  const history = trpc.daemon.executorHistory.useQuery({ daemonId: selected }, { enabled: Boolean(selected) });
  const refresh = trpc.daemon.refreshExecutor.useMutation({
    onSuccess: () => { toast.success("Refresh requested. The online daemon will perform a bounded status check."); void profiles.refetch(); void history.refetch(); },
    onError: error => toast.error(error.message),
  });
  const resume = trpc.daemon.resumeExecutor.useMutation({
    onSuccess: () => { setRetry(null); setReason(""); toast.success("Bounded retry authorized. Availability remains unverified until checked."); void profiles.refetch(); void history.refetch(); },
    onError: error => { toast.error(error.message); void profiles.refetch(); },
  });
  return <Card className="space-y-3 p-4">
    <h2 className="font-semibold">Executor availability</h2>
    <p className="text-xs text-muted-foreground">Local tool credential profiles are separate from managed Agent accounts and per-run token totals. Unknown allowance does not mean unlimited quota. Refresh verifies status; it never clears a cooldown or buys credits.</p>
    <label className="flex flex-wrap items-center gap-2 text-sm">Daemon
      <select aria-label="Executor daemon" className="max-w-full rounded border bg-background p-2" value={selected} onChange={event => setDaemonId(event.target.value)}>
        <option value="">Select a daemon</option>{daemons.map(daemon => <option key={daemon.id} value={daemon.id}>{daemon.name} · {daemon.id.slice(0,8)}</option>)}
      </select>
    </label>
    {daemonQuery.isError && <p role="alert">Executor daemons could not be loaded: {daemonQuery.error.message}</p>}
    {!selected ? <p className="text-sm text-muted-foreground">No visible daemon. Executor profiles appear after an authorized daemon reports status.</p>
      : profiles.isPending ? <p role="status">Loading executor profiles…</p>
      : profiles.isError ? <div role="alert" className="space-y-2"><p>{profiles.error.message}</p><Button variant="outline" onClick={() => void profiles.refetch()}>Retry inspection</Button></div>
      : profiles.data?.length === 0 ? <p className="text-sm text-muted-foreground">This daemon has not reported executor profiles. Older clients show unknown availability.</p>
      : <div className="grid gap-3 lg:grid-cols-2">{profiles.data?.map(profile => {
        const observation = profile.observation;
        return <section key={profile.id} className="min-w-0 space-y-2 rounded border p-3" aria-label={`${profile.tool} executor availability`}>
          <div className="flex flex-wrap items-center gap-2"><strong>{profile.tool}</strong><Badge variant="outline">{observation.state.replaceAll("_", " ")}</Badge><span className="text-xs">{observation.authenticationMode}</span></div>
          <p className="break-all text-xs">Profile {profile.profileId}{profile.poolId ? ` · Shared pool ${profile.poolId}` : " · Isolated profile"}</p>
          <p className="text-sm">{observation.reason}{profile.blocked && observation.state === "unknown" ? " A previously confirmed interruption still gates scheduling until recovery is verified." : ""}</p>
          <p className="text-xs text-muted-foreground">{observation.source} · {observation.confidence} confidence · version {observation.toolVersion ?? "unknown"}<br />Observed {new Date(observation.observedAt).toLocaleString()} · stale after {new Date(observation.staleAt).toLocaleString()}<br />Next check {profile.nextCheckAt ? new Date(profile.nextCheckAt).toLocaleString() : "operator action required"}</p>
          <ul className="space-y-1 text-xs">{observation.windows.map(window => <li key={`${window.bucket}:${window.window}`}>{window.bucket} · {window.window}: {window.remainingPercent === null ? "unknown" : `${window.remainingPercent}% remaining`} · {window.durationMinutes ?? "unknown"} min · reset {window.resetAt ? new Date(window.resetAt).toLocaleString() : "unknown"}</li>)}</ul>
          {observation.windows.length === 0 && <p className="text-xs text-muted-foreground">Remaining quota and reset windows are unavailable.</p>}
          <Button size="sm" variant="outline" disabled={refresh.isPending || Boolean(profile.refreshRequestedAt)} onClick={() => refresh.mutate({ daemonId: selected, tool: observation.tool })}>{profile.refreshRequestedAt ? "Refresh pending" : refresh.isPending ? "Requesting…" : "Refresh status"}</Button>
          {profile.blocked && <Button size="sm" variant="outline" className="ml-2" onClick={() => { setRetry({ tool: observation.tool, version: profile.version }); setReason(""); }}>Authorize retry</Button>}
        </section>;
      })}</div>}
    <Dialog open={Boolean(retry)} onOpenChange={open => { if (!open && !resume.isPending) setRetry(null); }}>
      <DialogContent><DialogHeader><DialogTitle>Authorize executor retry</DialogTitle><DialogDescription>Confirm that you corrected the provider authentication, billing or quota issue. This permits another attempt without claiming the executor is available. Existing interruption evidence remains in the timeline. Project management permission is required.</DialogDescription></DialogHeader>
        <label className="space-y-2 text-sm">Recovery reason<Textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></label>
        <DialogFooter><Button variant="outline" disabled={resume.isPending} onClick={() => setRetry(null)}>Cancel</Button><Button disabled={!reason.trim() || resume.isPending} onClick={() => { if (retry) resume.mutate({ daemonId: selected, tool: retry.tool, expectedVersion: retry.version, reason }); }}>{resume.isPending ? "Authorizing…" : "Authorize bounded retry"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {history.isError && <p role="alert" className="text-sm">Availability timeline could not be loaded.</p>}
    {history.data && history.data.length > 0 && <details><summary className="cursor-pointer text-sm">Availability timeline</summary><ul className="space-y-2 pt-2 text-xs">{history.data.map(event => <li key={event.id}>{new Date(event.observedAt).toLocaleString()} · {event.tool} · {event.state.replaceAll("_", " ")} · {event.reason}</li>)}</ul></details>}
  </Card>;
}
