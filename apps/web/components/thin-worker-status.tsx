"use client";

import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function time(value: Date | string) {
  return new Date(value).toLocaleString();
}

export function ThinWorkerStatus({ projectId }: { projectId: string }) {
  const workers = trpc.daemon.thinWorkers.useQuery({ projectId }, { refetchInterval: 30000 });
  const attempts = trpc.daemon.thinAttempts.useQuery({ projectId }, { refetchInterval: 30000 });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Worker presence</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {workers.isLoading && <p>Loading workers…</p>}
          {workers.error && <p role="alert">Could not load worker presence: {workers.error.message}</p>}
          {workers.data?.length === 0 && <p>No workers registered for this project.</p>}
          {workers.data?.map(worker => (
            <div key={worker.workerId} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={worker.status === "online" ? "default" : "secondary"}>{worker.status}</Badge>
              <span>{worker.nodeId}</span>
              <span className="text-muted-foreground">Last heartbeat: {time(worker.heartbeatAt)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent attempts</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {attempts.isLoading && <p>Loading attempts…</p>}
          {attempts.error && <p role="alert">Could not load attempts: {attempts.error.message}</p>}
          {attempts.data?.length === 0 && <p>No attempts recorded.</p>}
          {attempts.data?.map(attempt => {
            const summary = typeof attempt.result?.summary === "string" ? attempt.result.summary : null;
            const outputId = typeof attempt.result?.outputId === "string" ? attempt.result.outputId : null;
            return (
              <div key={attempt.id} className="space-y-1 border-b pb-3 text-sm last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={attempt.effectiveStatus === "attention" || attempt.effectiveStatus === "expired" ? "destructive" : "secondary"}>{attempt.effectiveStatus}</Badge>
                  <Link className="underline" href={`/projects/${projectId}/requirements/${attempt.requirementId}`}>Task {attempt.taskId.slice(0, 8)}</Link>
                  <span>on {attempt.nodeId}</span>
                </div>
                <p className="text-muted-foreground">Last heartbeat: {time(attempt.heartbeatAt)} · Lease expires: {time(attempt.expiresAt)} · Usage: unknown</p>
                {summary && <p className="whitespace-pre-wrap break-words">{summary}</p>}
                {outputId && <p>Shared evidence: {outputId}</p>}
                {(attempt.effectiveStatus === "attention" || attempt.effectiveStatus === "expired") && (
                  <p>Inspect the local workspace and any external effects before deciding whether the attempt is safe to retry.</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
