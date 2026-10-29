"use client";

import Link from "next/link";
import { History, RefreshCw, SearchCheck, UserRoundCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDateTime } from "./daemon-presentation";
import type { DaemonQueueView, TimelineRequirement } from "./daemon-view-model";

export function QueuePanel({
  items,
  viewLabel,
  now,
  actionsPending,
  onRetry,
  onHandoff,
  onShowTimeline,
}: {
  items: DaemonQueueView[];
  viewLabel: string;
  now: number;
  actionsPending: boolean;
  onRetry: (repository: DaemonQueueView["repositories"][number]) => void;
  onHandoff: (repository: DaemonQueueView["repositories"][number]) => void;
  onShowTimeline: (requirement: TimelineRequirement) => void;
}) {
  if (items.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
        <SearchCheck className="h-4 w-4" />
        No items in the {viewLabel.toLowerCase()} queue.
      </Card>
    );
  }

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {items.map((item) => (
        <Card key={item.requirementId} className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link href={`/projects/${item.projectId}/requirements/${item.requirementId}`} className="text-sm font-semibold hover:underline">
                {item.title}
              </Link>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.projectName}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Show run history for ${item.title}`}
                onClick={() => onShowTimeline({ id: item.requirementId, title: item.title })}
              >
                <History className="h-3.5 w-3.5" />
              </Button>
              <Badge variant="outline" className="h-5 px-2 text-[10px]">{item.role}</Badge>
              <Badge variant={item.state === "manual" ? "destructive" : "secondary"} className="h-5 px-2 text-[10px]">{item.priority}</Badge>
            </div>
          </div>

          {(item.executionSliceTitle || item.taskTitle) && (
            <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
              <span>slice <strong className="text-foreground">{item.executionSliceTitle ?? "—"}</strong></span>
              <span>task <strong className="text-foreground">{item.taskTitle ?? "—"}</strong></span>
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1">
            {item.reasonCodes.map((reason) => (
              <Badge key={reason} variant="outline" className="h-5 px-2 font-mono text-[10px]">{reason}</Badge>
            ))}
          </div>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>

          {item.repositories.filter((repository) => repository.deliveryStatus === "failed").map((repository) => {
            const retryTarget = repository.retryPhase ?? repository.retryRole ?? "delivery";
            const automaticallyWaking = repository.retryPolicy === "after_follow_up"
              || (repository.retryPolicy === "automatic"
                && repository.nextAttemptAt !== null
                && new Date(repository.nextAttemptAt).getTime() <= now);
            const alreadyManual = repository.retryPolicy === "manual";
            const retryDisabledReason = automaticallyWaking
              ? "A matching daemon can already acquire this retry"
              : !repository.linkId
                ? "Repository link identity is unavailable"
                : null;
            return (
              <div key={repository.linkId || repository.repositoryId} className="mt-2 rounded border border-destructive/20 bg-destructive/5 p-2 text-[11px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{repository.repositoryName}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{repository.repositoryKey}</p>
                  </div>
                  <Badge variant="destructive" className="h-5 px-2 text-[10px]">failed</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  {repository.failureCode && <span>code <strong className="text-foreground">{repository.failureCode}</strong></span>}
                  <span>attempt {repository.retryCount}</span>
                  <span>target <strong className="text-foreground">{retryTarget}</strong></span>
                  <span>
                    policy <strong className="text-foreground">
                      {repository.retryExhausted ? "manual · retry budget exhausted" : repository.retryPolicy ?? "unclassified"}
                    </strong>
                  </span>
                  {repository.nextAttemptAt && <span>next <strong className="text-foreground">{formatDateTime(repository.nextAttemptAt)}</strong></span>}
                </div>
                {repository.failureSummary && <p className="mt-1 text-foreground">{repository.failureSummary}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actionsPending || Boolean(retryDisabledReason)}
                    title={retryDisabledReason ?? `Wake the ${repository.retryRole ?? "target"} queue at the ${retryTarget} phase`}
                    onClick={() => onRetry(repository)}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry {retryTarget}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actionsPending || alreadyManual || !repository.linkId}
                    title={alreadyManual ? "This failure is already assigned to manual remediation" : "Keep the failure durable and assign it to operator remediation"}
                    onClick={() => onHandoff(repository)}
                  >
                    <UserRoundCog className="h-3 w-3" />
                    Manual handoff
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      ))}
    </div>
  );
}
