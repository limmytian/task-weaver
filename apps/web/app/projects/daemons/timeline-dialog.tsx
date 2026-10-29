"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime } from "./daemon-presentation";
import type { TimelineRequirement } from "./daemon-view-model";

export function TimelineDialog({
  requirement,
  onOpenChange,
}: {
  requirement: TimelineRequirement | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<"all" | "progress" | "task" | "delivery" | "review" | "merge" | "retry" | "control">("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [live, setLive] = useState(true);
  const history = trpc.daemon.history.useQuery({
    requirementId: requirement?.id ?? "00000000-0000-4000-8000-000000000000",
    limit: 100,
    cursor,
    ...(kind === "all" ? {} : { kind }),
  }, {
    enabled: Boolean(requirement),
    refetchInterval: requirement && live ? 30_000 : false,
  });

  return (
    <Dialog open={Boolean(requirement)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <div>
              <DialogTitle>Run and delivery history</DialogTitle>
              <DialogDescription>
                {requirement?.title ?? "Requirement timeline"} · progress messages, structured logs, review decisions, and delivery outcomes
              </DialogDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                  setCursor(undefined);
                }}
                aria-label="Filter run history by event kind"
                className="h-7 rounded border bg-background px-2 text-xs"
              >
                <option value="all">All events</option>
                <option value="progress">Progress</option>
                <option value="task">Tasks</option>
                <option value="delivery">Delivery</option>
                <option value="review">Review</option>
                <option value="merge">Merge</option>
                <option value="retry">Retry</option>
                <option value="control">Control</option>
              </select>
              <Button size="xs" variant="outline" onClick={() => setLive((value) => !value)} aria-label={live ? "Pause live timeline" : "Resume live timeline"}>
                {live ? "Pause live" : "Replay"}
              </Button>
              <Button size="xs" variant="outline" onClick={() => history.refetch()} disabled={history.isFetching} aria-label="Refresh requirement history">
                <RefreshCw className={`h-3 w-3 ${history.isFetching ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1">
          {history.isError ? (
            <div role="alert" className="flex items-center justify-between gap-3 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <span>{history.error.message}</span>
              <Button size="xs" variant="outline" onClick={() => history.refetch()}>Try again</Button>
            </div>
          ) : history.isLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading requirement timeline">
              {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)}
            </div>
          ) : !history.data || history.data.items.length === 0 ? (
            <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
              No progress or delivery events have been recorded yet.
            </div>
          ) : (
            <ol className="relative ml-2 space-y-3 border-l pl-5" aria-label="Requirement event timeline" aria-live="polite">
              {history.data.items.map((event) => (
                <li key={event.id} className="relative">
                  <span className={`absolute -left-[1.55rem] top-2 h-3 w-3 rounded-full border-2 border-background ${timelineKindColor(event.kind)}`} />
                  <div className="rounded border bg-card p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="h-5 px-2 text-[10px]">{event.kind}</Badge>
                          {event.isSnapshot && <Badge variant="secondary" className="h-5 px-2 text-[10px]">snapshot</Badge>}
                          <Badge variant="outline" className="h-5 px-2 text-[10px]">{event.severity}</Badge>
                          <span className="text-sm font-medium">{event.title}</span>
                          {event.status && <Badge variant="secondary" className="h-5 px-2 text-[10px]">{event.status}</Badge>}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {formatDateTime(event.occurredAt)}
                          {event.actor ? ` · ${event.actor}` : ""}
                          {event.runId ? ` · run ${event.runId.slice(0, 8)}` : ""}
                        </p>
                      </div>
                      {event.pullRequestUrl && (
                        <a
                          href={event.pullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Pull request <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    {event.summary && <p className="mt-2 text-xs">{event.summary}</p>}
                    {(event.executionSliceTitle || event.taskTitle || event.repositoryName) && (
                      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        {event.executionSliceTitle && <span>slice <strong className="text-foreground">{event.executionSliceTitle}</strong></span>}
                        {event.taskTitle && <span>task <strong className="text-foreground">{event.taskTitle}</strong></span>}
                        {event.repositoryName && <span>repository <strong className="text-foreground">{event.repositoryName}</strong></span>}
                      </div>
                    )}
                    {Object.keys(event.details).length > 0 && (
                      <details className="mt-2 rounded bg-muted/30 px-2 py-1 text-[11px]">
                        <summary className="cursor-pointer select-none font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          Event details
                        </summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {history.data?.nextCursor && (
            <div className="mt-3 flex justify-center">
              <Button size="xs" variant="outline" onClick={() => setCursor(history.data?.nextCursor ?? undefined)} disabled={history.isFetching}>
                Load older events
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function timelineKindColor(kind: string) {
  if (kind === "merge") return "bg-emerald-500";
  if (kind === "review") return "bg-fuchsia-500";
  if (kind === "retry") return "bg-amber-500";
  if (kind === "task") return "bg-blue-500";
  if (kind === "control") return "bg-slate-500";
  if (kind === "delivery") return "bg-cyan-500";
  return "bg-indigo-500";
}
