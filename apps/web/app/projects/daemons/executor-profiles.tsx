"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Clock3, HelpCircle, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { toast } from "sonner";
import type { ExecutorObservation, ExecutorTool } from "@task-weaver/core";
import { trpc } from "@/trpc/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const toolNames: Record<ExecutorTool, string> = {
  codex: "Codex", claude: "Claude", agy: "Antigravity", aider: "Aider", cursor: "Cursor",
};
const sourceNames: Record<ExecutorObservation["source"], string> = {
  status_query: "Provider status check", structured_error: "Provider error", text_error: "CLI diagnostic",
  unsupported: "Query unavailable", execution_success: "Successful run", manual_resume: "Operator retry",
};

function dateLabel(value: string | Date | null) {
  return value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not reported";
}

function availabilityPresentation(observation: ExecutorObservation, blocked: boolean) {
  if (observation.state === "action_required") return {
    label: "Action needed", icon: AlertCircle, color: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
    next: observation.failure === "auth_required" ? "Sign in to the CLI again, then authorize a retry." : "Resolve the provider billing issue, then authorize a retry.",
  };
  if (blocked) return {
    label: "Waiting for recovery", icon: Clock3, color: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    next: "New work is paused for this tool. Saved work stays available for recovery.",
  };
  if (observation.state === "available") return {
    label: "Available", icon: CheckCircle2, color: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    next: "No resource interruption is currently blocking this tool.",
  };
  return {
    label: "Not verified", icon: HelpCircle, color: "border-border bg-muted/50 text-muted-foreground",
    next: observation.source === "manual_resume" ? "Retry authorized. The next check or run will verify recovery." : "Remaining allowance is unknown. No confirmed resource interruption is blocking this tool.",
  };
}

export function ExecutorProfiles() {
  const daemonQuery = trpc.daemon.executorDaemons.useQuery(undefined, { refetchInterval: 30_000 });
  const daemons = daemonQuery.data ?? [];
  const [daemonId, setDaemonId] = useState("");
  const [retry, setRetry] = useState<{ daemonId: string; tool: ExecutorTool; version: number } | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<{ daemonId: string; tool: ExecutorTool; message: string } | null>(null);
  const selected = daemons.some(daemon => daemon.id === daemonId) ? daemonId : daemons[0]?.id ?? "";
  const profiles = trpc.daemon.executorProfiles.useQuery({ daemonId: selected }, { enabled: Boolean(selected), refetchInterval: 30_000 });
  const history = trpc.daemon.executorHistory.useQuery({ daemonId: selected }, { enabled: Boolean(selected), refetchInterval: 30_000 });
  const utils = trpc.useUtils();
  const invalidate = (id: string) => Promise.all([
    utils.daemon.executorProfiles.invalidate({ daemonId: id }),
    utils.daemon.executorHistory.invalidate({ daemonId: id }),
  ]);
  const refresh = trpc.daemon.refreshExecutor.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: (_data, input) => {
      toast.success("Status check queued", { description: "The daemon will check when online. Work stays paused until recovery is verified." });
      void invalidate(input.daemonId);
    },
    onError: (error, input) => setActionError({ ...input, message: error.message }),
  });
  const resume = trpc.daemon.resumeExecutor.useMutation({
    onSuccess: (_data, input) => {
      setRetry(null); setReason("");
      toast.success("Retry authorized", { description: "Availability remains unverified until the next check or run." });
      void invalidate(input.daemonId);
    },
    onError: (_error, input) => { void invalidate(input.daemonId); },
  });
  const blockedCount = profiles.data?.filter(profile => profile.blocked).length ?? 0;
  const staleRetry = Boolean(retry && profiles.data?.some(profile => profile.tool === retry.tool && profile.version !== retry.version));

  return <Card className="gap-0 overflow-hidden py-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4 sm:p-5">
      <div className="min-w-0 space-y-1">
        <h2 className="flex items-center gap-2 font-semibold"><Terminal className="size-4 text-muted-foreground" aria-hidden="true" />Executor availability</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Check which tools can take new work and what needs attention.</p>
      </div>
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <Select value={selected} onValueChange={value => { setDaemonId(value); setActionError(null); }} disabled={daemonQuery.isPending || daemons.length === 0}>
          <SelectTrigger aria-label="Executor daemon" className="w-full min-w-0 sm:w-64"><SelectValue placeholder="Select a daemon" /></SelectTrigger>
          <SelectContent>{daemons.map(daemon => <SelectItem key={daemon.id} value={daemon.id}>{daemon.name} · {daemon.id.slice(0,8)}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="icon" aria-label="Reload executor observations" disabled={daemonQuery.isFetching || profiles.isFetching} onClick={() => { void daemonQuery.refetch(); if (selected) { void profiles.refetch(); void history.refetch(); } }}>
          <RefreshCw className={cn("size-4", (daemonQuery.isFetching || profiles.isFetching) && "animate-spin")} aria-hidden="true" />
        </Button>
      </div>
    </div>

    <div className="space-y-4 p-4 sm:p-5">
      {daemonQuery.isError ? <div role="alert" className="space-y-2 rounded-lg border p-4"><p className="font-medium">Executor daemons could not be loaded</p><p className="break-words text-sm text-muted-foreground">{daemonQuery.error.message}</p><Button variant="outline" onClick={() => void daemonQuery.refetch()}>Try again</Button></div>
        : daemonQuery.isPending || (selected && profiles.isPending) ? <div role="status" aria-label="Loading executor availability" className="grid gap-3 lg:grid-cols-2">{[0,1].map(key => <div key={key} className="h-48 animate-pulse rounded-lg border bg-muted/40" />)}<span className="sr-only">Loading executor availability…</span></div>
        : !selected ? <div className="rounded-lg border border-dashed p-6 text-center"><Terminal className="mx-auto mb-2 size-5 text-muted-foreground" aria-hidden="true" /><p className="font-medium">No executor daemons to inspect</p><p className="mt-1 text-sm text-muted-foreground">Profiles appear when a daemon you can access reports its tools.</p></div>
        : profiles.isError ? <div role="alert" className="space-y-2 rounded-lg border p-4"><p className="font-medium">Executor status could not be loaded</p><p className="break-words text-sm text-muted-foreground">{profiles.error.message}</p><Button variant="outline" onClick={() => void profiles.refetch()}>Retry inspection</Button></div>
        : profiles.data?.length === 0 ? <div className="rounded-lg border border-dashed p-6"><p className="font-medium">Waiting for the first tool report</p><p className="mt-1 text-sm text-muted-foreground">This daemon has not reported executor availability. Check that it is online and running an updated CLI.</p></div>
        : <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>{profiles.data?.length} tools <span className="text-muted-foreground">· {blockedCount ? `${blockedCount} waiting for recovery` : "No confirmed resource blocks"}</span></p>
            <p className="text-xs text-muted-foreground">Observation updates every 30 seconds</p>
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-2">{profiles.data?.map(profile => {
            const observation = profile.observation;
            const presentation = availabilityPresentation(observation, profile.blocked);
            const StateIcon = presentation.icon;
            const supportsQuery = observation.tool === "codex";
            const refreshing = refresh.isPending && refresh.variables?.daemonId === selected && refresh.variables.tool === observation.tool;
            const error = actionError?.daemonId === selected && actionError.tool === observation.tool ? actionError.message : null;
            return <section key={profile.id} className="min-w-0 overflow-hidden rounded-lg border" aria-label={`${toolNames[observation.tool]} executor availability`}>
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{toolNames[observation.tool]}{observation.tool === "agy" && <span className="ml-1.5 text-xs font-normal text-muted-foreground">agy</span>}</h3>
                  <Badge variant="outline" className={cn("gap-1.5", presentation.color)}><StateIcon className="size-3" aria-hidden="true" />{presentation.label}</Badge>
                </div>
                <p className="text-sm">{presentation.next}</p>
                {profile.blocked && <div className="rounded-md bg-muted/50 p-3 text-sm"><p>{observation.reason}</p><p className="mt-1 text-xs text-muted-foreground">{profile.nextCheckAt ? `Next automatic check: ${dateLabel(profile.nextCheckAt)}` : "Automatic checks are paused until the provider issue is corrected."}</p></div>}
                {observation.windows.length > 0 ? <div className="space-y-3">{observation.windows.map(window => <div key={`${window.bucket}:${window.window}`} className="space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"><span className="min-w-0 break-all text-muted-foreground">{window.bucket} · {window.window === "primary" ? "Primary window" : "Secondary window"}</span><strong className="text-sm tabular-nums">{window.remainingPercent === null ? "Remaining unknown" : `${window.remainingPercent}% remaining`}</strong></div>
                  {window.remainingPercent !== null && <div role="progressbar" aria-label={`${toolNames[observation.tool]} ${window.bucket} ${window.window} quota remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", window.remainingPercent <= 10 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${window.remainingPercent}%` }} /></div>}
                  <p className="text-xs text-muted-foreground">{window.durationMinutes ? `${window.durationMinutes} min window · ` : ""}{window.resetAt ? `Resets ${dateLabel(window.resetAt)}` : "Reset time not reported"}</p>
                </div>)}</div> : <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground"><p className="font-medium text-foreground">Remaining quota is unknown</p><p className="mt-1">{observation.tool === "agy" ? <>Antigravity offers <code>/usage</code> (or <code>/quota</code>) in its interactive CLI. Automatic quota checks are not connected in Task Weaver.</> : supportsQuery ? "No current quota windows were returned. A successful run alone does not report remaining allowance." : "Task Weaver has no verified automatic quota query for this tool. Explicit resource errors can still pause new work."}</p></div>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>Checked {dateLabel(observation.observedAt)}</span><span>{supportsQuery ? "Automatic query supported" : "Automatic query not connected"}</span></div>
                {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
                <div className="flex flex-wrap gap-2">
                  {profile.blocked && <Button size="sm" onClick={() => { setRetry({ daemonId: selected, tool: observation.tool, version: profile.version }); setReason(""); resume.reset(); }}>Authorize retry</Button>}
                  {supportsQuery && <Button size="sm" variant="outline" disabled={refreshing || Boolean(profile.refreshRequestedAt)} onClick={() => refresh.mutate({ daemonId: selected, tool: observation.tool })}><RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden="true" />{profile.refreshRequestedAt ? "Check queued" : refreshing ? "Requesting…" : "Check quota"}</Button>}
                </div>
                {profile.refreshRequestedAt && <p role="status" className="text-xs text-muted-foreground">Waiting for the daemon to check. It must be online; the current recovery state stays in effect.</p>}
              </div>
              <details className="border-t bg-muted/20 px-4 py-2.5"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Technical details</summary><dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt className="text-muted-foreground">Profile</dt><dd className="break-all font-mono">{profile.profileId}</dd><dt className="text-muted-foreground">Sharing</dt><dd className="break-all">{profile.poolId ?? "Isolated profile"}</dd><dt className="text-muted-foreground">Authentication</dt><dd>{observation.authenticationMode.replace("_", " ")}</dd><dt className="text-muted-foreground">Source</dt><dd>{sourceNames[observation.source]} · {observation.confidence} confidence</dd><dt className="text-muted-foreground">CLI version</dt><dd className="break-all">{observation.toolVersion ?? "Not reported"}</dd><dt className="text-muted-foreground">Fresh until</dt><dd>{dateLabel(observation.staleAt)}</dd></dl></details>
            </section>;
          })}</div>
          <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Quota checks do not spend model credits. Tool quota is separate from Agent permissions and run token totals.</p>
        </>}
      {selected && <details className="group rounded-lg border"><summary className="flex cursor-pointer list-none items-center justify-between p-3 text-sm font-medium">Recovery history<span className="flex items-center gap-2 text-xs text-muted-foreground">{history.data?.length ? `${history.data.length} events` : ""}<ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" /></span></summary>
        <div className="border-t p-3">{history.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading recovery history…</p> : history.isError ? <div role="alert" className="space-y-2"><p className="text-sm">Recovery history could not be loaded.</p><Button size="sm" variant="outline" onClick={() => void history.refetch()}>Retry history</Button></div> : !history.data?.length ? <p className="text-sm text-muted-foreground">No recovery events have been recorded.</p> : <ol className="max-h-72 space-y-3 overflow-y-auto">{history.data.map(event => <li key={event.id} className="border-l-2 pl-3"><div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><strong>{toolNames[event.tool as ExecutorTool] ?? event.tool}</strong><span className="text-muted-foreground">{event.state.replaceAll("_", " ")} · {dateLabel(event.observedAt)}</span></div><p className="mt-1 break-words text-xs text-muted-foreground">{event.reason}</p></li>)}</ol>}</div>
      </details>}
    </div>

    <Dialog open={Boolean(retry)} onOpenChange={open => { if (!open && !resume.isPending) setRetry(null); }}>
      <DialogContent onEscapeKeyDown={event => { if (resume.isPending) event.preventDefault(); }} onInteractOutside={event => { if (resume.isPending) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Retry {retry ? toolNames[retry.tool] : "executor"} after recovery?</DialogTitle><DialogDescription>Use this after correcting the provider sign-in, billing or quota issue. New work may run again; this does not verify remaining quota or buy credits.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (retry && reason.trim() && !resume.isPending && !staleRetry) resume.mutate({ ...retry, expectedVersion: retry.version, reason: reason.trim() }); }}>
          <div className="space-y-2"><label htmlFor="executor-recovery-reason" className="text-sm font-medium">Recovery reason <span className="text-muted-foreground">(required)</span></label><Textarea id="executor-recovery-reason" aria-describedby="executor-recovery-help" autoFocus value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={resume.isPending} placeholder="For example: signed in again after the quota reset" /><p id="executor-recovery-help" className="text-xs text-muted-foreground">Recorded in the audit log. Do not include credentials or payment details.</p></div>
          {staleRetry && <p role="alert" className="text-sm text-destructive">Status changed while this dialog was open. Close it and review the latest status before retrying.</p>}
          {resume.isError && <p role="alert" className="break-words text-sm text-destructive">{resume.error.message}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={resume.isPending} onClick={() => setRetry(null)}>Cancel</Button><Button type="submit" disabled={!reason.trim() || resume.isPending || staleRetry}>{resume.isPending ? "Authorizing…" : "Authorize retry"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </Card>;
}
