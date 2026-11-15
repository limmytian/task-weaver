"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/trpc/routers/_app";

type Outputs = inferRouterOutputs<AppRouter>;
type QueryView<T> = { data?: T; isLoading: boolean; error?: string };

function time(value: Date | string) {
  return new Date(value).toLocaleString();
}

export function ThinWorkerStatus({ projectId }: { projectId: string }) {
  const workers = trpc.worker.thinWorkers.useQuery({ projectId }, { refetchInterval: 30000 });
  const attempts = trpc.worker.thinAttempts.useQuery({ projectId }, { refetchInterval: 30000 });

  return <ThinWorkerStatusContent projectId={projectId}
    renderResolution={attemptId => <ResolveAttempt attemptId={attemptId} />}
    workers={{ data: workers.data, isLoading: workers.isLoading, error: workers.error?.message }}
    attempts={{ data: attempts.data, isLoading: attempts.isLoading, error: attempts.error?.message }} />;
}

export function ThinWorkerStatusContent({ projectId, workers, attempts, renderResolution }: {
  projectId: string;
  workers: QueryView<Outputs['worker']['thinWorkers']>;
  attempts: QueryView<Outputs['worker']['thinAttempts']>;
  renderResolution?: (attemptId: string) => React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Worker presence</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {workers.isLoading && <p>Loading workers…</p>}
          {workers.error && <p role="alert">Could not load worker presence: {workers.error}</p>}
          {workers.data?.length === 0 && <p>No workers registered for this project.</p>}
          {workers.data?.map(worker => (
            <div key={worker.workerId} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={worker.status === "online" ? "default" : "secondary"}>{worker.status}</Badge>
              <span>{worker.nodeId}</span>
              <span className="text-muted-foreground">Last heartbeat: {time(worker.heartbeatAt)}</span>
              <span>{worker.status === "online" ? "Activity" : "Last reported activity"}: {worker.activity === "checking" ? "checking or executing" : worker.activity}</span>
              <span className="text-muted-foreground">Reported since: {time(worker.activityChangedAt)}</span>
              {worker.reason && <span className="break-words">{worker.reason}</span>}
              {worker.retryAt && <span>Retry after: {time(worker.retryAt)}</span>}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent attempts</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {attempts.isLoading && <p>Loading attempts…</p>}
          {attempts.error && <p role="alert">Could not load attempts: {attempts.error}</p>}
          {attempts.data?.length === 0 && <p>No attempts recorded.</p>}
          {attempts.data?.map(attempt => {
            const summary = typeof attempt.result?.summary === "string" ? attempt.result.summary : null;
            const outputId = typeof attempt.result?.outputId === "string" ? attempt.result.outputId : null;
            return (
              <div key={attempt.id} className="space-y-1 border-b pb-3 text-sm last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={attempt.effectiveStatus === "attention" || attempt.effectiveStatus === "expired" ? "destructive" : "secondary"}>{attempt.effectiveStatus}</Badge>
                  <Link className="underline" href={`/projects/${projectId}/requirements/${attempt.requirementId}?task=${attempt.taskId}`}>{attempt.taskTitle || `Task ${attempt.taskId.slice(0, 8)}`}</Link>
                  <span>on {attempt.nodeId}</span>
                </div>
                <p className="text-muted-foreground">Started: {time(attempt.createdAt)} · Last heartbeat: {time(attempt.heartbeatAt)} · Lease expires: {time(attempt.expiresAt)} · Usage: unknown</p>
                {summary && <p className="whitespace-pre-wrap break-words">{summary}</p>}
                {outputId ? <p>Shared evidence: {outputId} · <Link className="underline" href={`/projects/${projectId}/requirements/${attempt.requirementId}`}>View delivered work</Link></p> : <p>Shared evidence: unavailable. Local workspace may contain additional evidence.</p>}
                {(attempt.effectiveStatus === "attention" || attempt.effectiveStatus === "expired") && (
                  <><p>Inspect the local workspace and any external effects before deciding whether the attempt is safe to retry.</p>{renderResolution?.(attempt.id)}</>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function ResolveAttempt({ attemptId }: { attemptId: string }) {
  const [reason, setReason] = useState("");
  const [retrySafe, setRetrySafe] = useState(false);
  const utils = trpc.useUtils();
  const resolve = trpc.worker.resolveAttempt.useMutation({ onSuccess: () => { void utils.worker.thinAttempts.invalidate(); void utils.attention.list.invalidate(); } });
  return <details><summary className="cursor-pointer">Resolve attempt</summary>
    <p>Record what you inspected and any external effects. Resolution requires project management permission.</p>
    <label className="block">Inspection reason<textarea className="block w-full rounded border bg-background p-2" value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label>
    <label className="block"><input type="checkbox" checked={retrySafe} onChange={event => setRetrySafe(event.target.checked)} /> I inspected external effects and determined retry is safe.</label>
    <div className="flex gap-2"><button className="rounded border px-2 py-1" disabled={reason.trim().length < 10 || resolve.isPending} onClick={() => resolve.mutate({ attemptId, reason, disposition: "review", retrySafe: false })}>Send to review</button><button className="rounded border px-2 py-1" disabled={reason.trim().length < 10 || !retrySafe || resolve.isPending} onClick={() => resolve.mutate({ attemptId, reason, disposition: "retry", retrySafe })}>Retry task</button></div>
    {resolve.error && <p role="alert">Resolution failed: {resolve.error.message}</p>}
    {resolve.isSuccess && <p role="status">Resolution recorded.</p>}
  </details>;
}
