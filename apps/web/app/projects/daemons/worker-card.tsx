"use client";

import { WorkerConsole } from "./worker-console";
import { AlertCircle, GitBranch, History, ListChecks, MapPinned } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isLeaseAtRisk } from "./control-plane";
import { formatRelativeTime, taskBadgeVariant, requirementStatusLabels } from "./daemon-presentation";
import type { DaemonWorkerView, TimelineRequirement } from "./daemon-view-model";

export function WorkerCard({
  worker,
  now,
  onShowTimeline,
}: {
  worker: DaemonWorkerView;
  now: number;
  onShowTimeline: (requirement: TimelineRequirement) => void;
}) {
  const idle = worker.status === "idle" && !worker.requirementId;
  const roadmap = Array.isArray(worker.roadmap) ? worker.roadmap : [];
  const leaseGeneration = worker.leaseGeneration ?? worker.claim?.generation;
  const leaseUnhealthy = isLeaseAtRisk(worker, now);

  if (idle) {
    return (
      <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/10 px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-2 font-medium">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          worker {worker.index}
        </span>
        <span className="text-muted-foreground">idle · ready for work</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={worker.status === "running" ? "default" : "secondary"} className="h-5 px-2 text-[10px]">
              worker {worker.index} · {worker.status}
            </Badge>
            {leaseUnhealthy && <Badge variant="destructive" className="h-5 px-2 text-[10px]">lease at risk</Badge>}
            {worker.requirement && <span className="truncate text-sm font-medium">{worker.requirement.title}</span>}
          </div>
          {worker.requirement && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span className="font-mono">{worker.requirement.id.slice(0, 8)}...</span>
              <span>{requirementStatusLabels[worker.requirement.status] ?? worker.requirement.status}</span>
              {worker.modelTier && <span>tier {worker.modelTier}</span>}
              {worker.model && <span className="font-mono">{worker.model}</span>}
              {worker.reasoningEffort && <span>think {worker.reasoningEffort}</span>}
              {worker.requirement.branchName && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  <span className="truncate font-mono">{worker.requirement.branchName}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {worker.requirement && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Show run history for ${worker.requirement.title}`}
              onClick={() => onShowTimeline({ id: worker.requirement!.id, title: worker.requirement!.title })}
            >
              <History className="h-3 w-3" /> History
            </Button>
          )}
          {worker.worktreePath && (
            <span className="max-w-[180px] truncate font-mono text-[10px] text-muted-foreground" title={worker.worktreePath}>{worker.worktreePath}</span>
          )}
        </div>
      </div>

      <div className="mt-2 grid gap-1 rounded border bg-background/70 p-2 text-[11px] sm:grid-cols-2">
        <span className="inline-flex items-center gap-1.5">
          <MapPinned className="h-3.5 w-3.5 text-amber-500" />
          slice <strong>{worker.executionSlice?.title ?? worker.executionSliceId ?? "—"}</strong>
        </span>
        <span>task <strong>{worker.taskTitle ?? worker.taskId ?? "—"}</strong></span>
        <span>lease generation <strong>{leaseGeneration ?? "—"}</strong></span>
        <span>lease heartbeat <strong>{formatRelativeTime(worker.claim?.heartbeatAt, now)}</strong></span>
        <span className={leaseUnhealthy ? "text-destructive" : "text-muted-foreground"}>
          lease {leaseUnhealthy ? "unhealthy" : worker.leaseHealthy === true ? "healthy" : "reported"}
        </span>
        <span className={worker.leaseHeartbeatFailures ? "text-destructive" : "text-muted-foreground"}>
          renewal failures {worker.leaseHeartbeatFailures ?? 0}
        </span>
      </div>

      {worker.lastLeaseError && (
        <div role="alert" className="mt-2 flex gap-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{worker.lastLeaseError}</span>
        </div>
      )}

      {worker.requirementId && worker.taskId && worker.runId && leaseGeneration != null && <WorkerConsole key={worker.runId} target={{ requirementId: worker.requirementId, taskId: worker.taskId, runId: worker.runId, workerIndex: worker.index, leaseGeneration }} />}

      {worker.progress && (
        <div className="mt-2 space-y-1 rounded border bg-background/70 p-2 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-5 px-2 text-[10px]">{worker.progress.phase}</Badge>
            <span>workspace {worker.progress.workspaceState ?? "unknown"}</span>
            <span>recovery {worker.progress.recoveryDisposition ?? "none"}</span>
            <span>retry {worker.progress.retryCount ?? 0}</span>
            <span>event {formatRelativeTime(worker.progress.lastEventAt, now)}</span>
          </div>
          {worker.progress.message && <p className="text-foreground">{worker.progress.message}</p>}
          {worker.progress.handoffSummary && <p>handoff: {worker.progress.handoffSummary}</p>}
        </div>
      )}

      {roadmap.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" />
            Roadmap
          </div>
          <div className="grid gap-1">
            {roadmap.map((task) => (
              <div key={task.id} className="flex min-w-0 items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${task.id === worker.taskId ? "bg-amber-500" : "bg-border"}`} />
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${taskBadgeVariant(task.status)}`}>{task.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
