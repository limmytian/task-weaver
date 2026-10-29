"use client";

import { OperatorActionDialog } from "./operator-action-dialog";
import { TimelineDialog } from "./timeline-dialog";
import { QueuePanel } from "./queue-panel";
import { WorkerCard } from "./worker-card";
import { ExecutorProfiles } from "./executor-profiles";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Bot, RefreshCw, ServerCog, ShieldAlert } from "lucide-react";
import { trpc } from "@/trpc/client";
import { useRealtimeStatus } from "@/components/realtime-provider";
import { QueryStatePanel } from "@/components/query-state-panel";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { normalizeWorkerSlots, isDaemonStale, queueItemsForView, summarizeRoleCapacity, type DaemonRole } from "./control-plane";
import { statusColor, formatRelativeTime, formatDateTime, sloStatusClass, sloTarget, rolePresentation, queueViews } from "./daemon-presentation";
import type { DaemonWorkerView, DaemonQueueView, OperatorAction, TimelineRequirement } from "./daemon-view-model";

export default function DaemonsPage() {
  const realtime = useRealtimeStatus();
  const utils = trpc.useUtils();
  const daemonQuery = trpc.daemon.list.useQuery(undefined, { refetchInterval: 30_000 });
  const queueQuery = trpc.daemon.queues.useQuery(undefined, { refetchInterval: 30_000 });
  const overviewQuery = trpc.daemon.overview.useQuery({ includeOffline: true, limit: 100 }, { refetchInterval: 30_000 });
  const sloQuery = trpc.daemon.slo.useQuery({ windowHours: 24 }, { refetchInterval: 30_000 });
  const metricsQuery = trpc.daemon.metrics.useQuery({ windowHours: 24, bucketMinutes: 60 }, { refetchInterval: 30_000 });
  const [now, setNow] = useState(() => Date.now());
  const [operatorAction, setOperatorAction] = useState<OperatorAction | null>(null);
  const [operatorReason, setOperatorReason] = useState("");
  const [timelineRequirement, setTimelineRequirement] = useState<TimelineRequirement | null>(null);

  const daemonControl = trpc.daemon.control.useMutation({
    onMutate: async (input) => {
      await utils.daemon.list.cancel();
      const previous = utils.daemon.list.getData();
      const controlState = input.action === "pause"
        ? "paused" as const
        : input.action === "drain"
          ? "draining" as const
          : "running" as const;
      utils.daemon.list.setData(undefined, (current) => current?.map((daemon) =>
        daemon.id === input.daemonId
          ? {
              ...daemon,
              controlState,
              controlReason: input.reason,
              controlRequestedAt: new Date(),
            }
          : daemon,
      ));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) utils.daemon.list.setData(undefined, context.previous);
    },
    onSettled: async () => {
      await Promise.all([
        utils.daemon.list.invalidate(),
        utils.daemon.queues.invalidate(),
      ]);
    },
  });
  const retryDelivery = trpc.repository.retryDelivery.useMutation();
  const manualHandoff = trpc.repository.manualHandoff.useMutation();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const daemons = useMemo(() => daemonQuery.data ?? [], [daemonQuery.data]);
  const daemonsWithWorkers = useMemo(() => daemons.map((daemon) => ({
    ...daemon,
    workerStates: ((daemon as typeof daemon & { workerStates?: DaemonWorkerView[] }).workerStates ?? []),
  })), [daemons]);
  const capacityByRole = summarizeRoleCapacity(daemonsWithWorkers);
  const onlineCount = daemons.length;
  const configuredCapacity = capacityByRole.reduce((total, role) => total + role.configured, 0);
  const workerCount = capacityByRole.reduce((total, role) => total + role.active, 0);
  const idleWorkers = capacityByRole.reduce((total, role) => total + role.idle, 0);
  const staleCount = daemons.filter((daemon) => isDaemonStale(daemon.lastHeartbeatAt, now)).length;
  const queueItems = (queueQuery.data?.items ?? []) as DaemonQueueView[];
  const isFetching = daemonQuery.isFetching || queueQuery.isFetching || overviewQuery.isFetching || sloQuery.isFetching || metricsQuery.isFetching;

  function refreshControlPlane() {
    void Promise.all([daemonQuery.refetch(), queueQuery.refetch(), sloQuery.refetch(), metricsQuery.refetch()]);
  }

  function openOperatorAction(action: OperatorAction) {
    setOperatorAction(action);
    setOperatorReason(action.kind === "daemon" || action.kind === "pipeline"
      ? `${action.action[0]!.toUpperCase()}${action.action.slice(1)} requested from the Web control plane`
      : action.kind === "retry"
        ? `Retry ${action.repositoryName} after operator verification`
        : `Hand off ${action.repositoryName} for manual remediation`);
  }

  async function submitOperatorAction() {
    if (!operatorAction || operatorReason.trim().length < 3) return;
    try {
      if (operatorAction.kind === "daemon" || operatorAction.kind === "pipeline") {
        const daemonIds = operatorAction.kind === "daemon"
          ? [operatorAction.daemonId]
          : operatorAction.daemonIds;
        await Promise.all(daemonIds.map((daemonId) => daemonControl.mutateAsync({
          daemonId,
          action: operatorAction.action,
          reason: operatorReason.trim(),
        })));
        const targetName = operatorAction.kind === "daemon"
          ? operatorAction.daemonName
          : `${operatorAction.pipelineName} (${daemonIds.length} daemons)`;
        toast.success(`${targetName} is now ${operatorAction.action === "resume" ? "accepting work" : operatorAction.action === "pause" ? "paused" : "draining"}`);
      } else if (operatorAction.kind === "retry") {
        const result = await retryDelivery.mutateAsync({
          linkId: operatorAction.linkId,
          reason: operatorReason.trim(),
        });
        toast.success(`Retry routed to ${result.targetRole} (${result.targetPhase})`);
      } else {
        await manualHandoff.mutateAsync({
          linkId: operatorAction.linkId,
          reason: operatorReason.trim(),
        });
        toast.success(`${operatorAction.repositoryName} moved to manual remediation`);
      }
      await utils.daemon.queues.invalidate();
      setOperatorAction(null);
      setOperatorReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operator action failed");
    }
  }

  const operatorActionPending = daemonControl.isPending || retryDelivery.isPending || manualHandoff.isPending;

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="flex items-center gap-1.5 text-lg font-semibold">
          <ServerCog className="h-5 w-5 text-indigo-500" />
          Daemon control plane
        </h1>
        {!daemonQuery.isLoading && (
          <div className="ml-auto hidden items-center gap-3 text-sm text-muted-foreground sm:flex">
            <span>{onlineCount} online</span>
            <span className="font-medium text-amber-600">{workerCount} active</span>
            <span className="font-medium text-emerald-600">{idleWorkers} idle</span>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-2"
          onClick={refreshControlPlane}
          disabled={isFetching}
          aria-label="Refresh daemon control plane"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      <main className="flex-1 space-y-6 overflow-y-auto p-4 md:p-6">
        <ExecutorProfiles />
        <section aria-labelledby="now-heading" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="now-heading" className="text-base font-semibold">Now</h2>
              <p className="text-xs text-muted-foreground">One consistent snapshot of process liveness, worker health, queues, and next actions.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className={realtime.connectionState === "live" ? "border-emerald-200 text-emerald-700" : "border-amber-200 text-amber-700"}>
                realtime · {realtime.connectionState}
              </Badge>
              {overviewQuery.data?.asOf && <span>as of {formatRelativeTime(overviewQuery.data.asOf, now)}</span>}
            </div>
          </div>
          {overviewQuery.isError ? (
            <QueryStatePanel icon={<AlertTriangle className="h-5 w-5" />} title="Current snapshot unavailable" description={overviewQuery.error.message} onAction={() => void overviewQuery.refetch()} />
          ) : overviewQuery.isLoading ? (
            <LoadingCards />
          ) : overviewQuery.data ? (
            <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Health · {overviewQuery.data.health}</span>
                  <span className="text-xs text-muted-foreground">{overviewQuery.data.daemons.length} daemons · {overviewQuery.data.queue.total} queue items</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {overviewQuery.data.daemons.slice(0, 6).map((daemon) => (
                    <div key={daemon.id} className="flex items-center justify-between rounded border px-2.5 py-2 text-xs">
                      <span className="min-w-0 truncate font-medium">{daemon.name}</span>
                      <span className={daemon.liveness === "online" ? "text-emerald-600" : daemon.liveness === "stale" ? "text-amber-600" : "text-destructive"}>{daemon.liveness}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Next actions</span>
                  <span className="text-xs text-muted-foreground">{overviewQuery.data.alerts.length} alerts</span>
                </div>
                {overviewQuery.data.nextActions.length === 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">No deterministic next actions are currently available.</p>
                ) : (
                  <ul className="mt-3 space-y-1.5 text-xs" aria-live="polite">
                    {overviewQuery.data.nextActions.slice(0, 4).map((action, index) => (
                      <li key={`${action.kind}-${action.requirementId ?? index}`} className="flex items-start gap-2 rounded border px-2.5 py-2">
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{action.kind}</Badge>
                        <span className="min-w-0 flex-1">
                          <span className="block">{action.reason}</span>
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {action.confidence === "unknown" ? "forecast unknown" : action.policy}
                            {action.blockingEntity ? ` · blocked by ${action.blockingEntity.label}` : ""}
                            {action.requiredCapability ? ` · needs ${action.requiredCapability}` : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          ) : null}
        </section>
        {sloQuery.data && (
          <section aria-labelledby="slo-dashboard-heading" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="slo-dashboard-heading" className="text-base font-semibold">Production SLOs</h2>
                <p className="text-xs text-muted-foreground">
                  Rolling 24-hour release evidence for acquisition, health, completion, retry, review, merge, and recovery.
                </p>
              </div>
              <Badge className={sloQuery.data.releaseStatus === "pass"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-700"}
              >
                Release {sloQuery.data.releaseStatus}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {sloQuery.data.metrics.map((metric) => (
                <Card key={metric.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">{metric.displayValue}</p>
                    </div>
                    <Badge variant="outline" className={sloStatusClass(metric.status)}>{metric.status.replace("_", " ")}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Target {sloTarget(metric)} · {metric.sampleCount} samples
                  </p>
                </Card>
              ))}
            </div>
            {sloQuery.data.alerts.length > 0 && (
              <Card className="border-red-200 bg-red-50/50 p-4 dark:bg-red-950/10">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
                  <AlertTriangle className="h-4 w-4" />
                  Active production alerts
                </div>
                <div className="space-y-2">
                  {sloQuery.data.alerts.map((alert) => (
                    <div key={alert.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                      <div>
                        <p className="font-medium">{alert.title}</p>
                        <p className="text-xs text-muted-foreground">{alert.summary}</p>
                      </div>
                      <Badge variant="outline" className={alert.severity === "critical"
                        ? "border-red-300 text-red-700"
                        : "border-amber-300 text-amber-700"}
                      >
                        {alert.severity}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </section>
        )}
        {metricsQuery.data && (
          <section aria-labelledby="metrics-heading" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="metrics-heading" className="text-base font-semibold">Daemon trends</h2>
                <p className="text-xs text-muted-foreground">
                  {metricsQuery.data.windowHours}h buckets · {metricsQuery.data.bucketMinutes}m resolution · {metricsQuery.data.sampleCount} canonical events
                </p>
              </div>
              <Badge variant="outline" className={metricsQuery.data.noData ? "border-amber-200 text-amber-700" : "border-emerald-200 text-emerald-700"}>
                {metricsQuery.data.noData ? "No data" : `${metricsQuery.data.series.length - 1} daemon series`}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(() => {
                const point = metricsQuery.data.series[0]?.points.at(-1);
                const values = point?.values;
                return [
                  ["Queue depth", values?.queueDepth ?? 0],
                  ["Active workers", values?.activeWorkers ?? 0],
                  ["Retry events", values?.retryEvents ?? 0],
                  ["No-progress age", `${Math.round(values?.noProgressSeconds ?? 0)}s`],
                ].map(([label, value]) => (
                  <Card key={String(label)} className="p-4">
                    <p className="text-xs font-medium text-muted-foreground">{label}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
                    <p className="mt-2 text-xs text-muted-foreground">latest aggregate bucket</p>
                  </Card>
                ));
              })()}
            </div>
            {metricsQuery.data.alerts.length > 0 && (
              <Card className="border-amber-200 bg-amber-50/50 p-4 dark:bg-amber-950/10">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700">
                  <ShieldAlert className="h-4 w-4" />
                  Actionable trend alerts
                </div>
                <div className="space-y-1 text-xs">
                  {metricsQuery.data.alerts.slice(0, 6).map((alert) => (
                    <div key={alert.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{alert.message}</span>
                      <span className="text-muted-foreground">runbook {alert.runbook}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </section>
        )}
        {!daemonQuery.isLoading && (
          <section aria-labelledby="capacity-summary-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 id="capacity-summary-heading" className="text-base font-semibold">Pipeline capacity</h2>
                <p className="text-xs text-muted-foreground">Apply lifecycle controls across every eligible role daemon.</p>
              </div>
              <div className="flex gap-1" aria-label="Pipeline lifecycle controls">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!daemonsWithWorkers.some((daemon) => (daemon.controlState ?? "running") === "running") || daemonControl.isPending}
                  title="Pause acquisition across every running daemon without interrupting active work"
                  onClick={() => openOperatorAction({
                    kind: "pipeline",
                    pipelineName: "Pipeline",
                    action: "pause",
                    daemonIds: daemonsWithWorkers
                      .filter((daemon) => (daemon.controlState ?? "running") === "running")
                      .map((daemon) => daemon.id),
                  })}
                >
                  Pause all
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!daemonsWithWorkers.some((daemon) => ["running", "paused"].includes(daemon.controlState ?? "running")) || daemonControl.isPending}
                  title="Stop all new acquisition and let active workers reach a safe boundary"
                  onClick={() => openOperatorAction({
                    kind: "pipeline",
                    pipelineName: "Pipeline",
                    action: "drain",
                    daemonIds: daemonsWithWorkers
                      .filter((daemon) => ["running", "paused"].includes(daemon.controlState ?? "running"))
                      .map((daemon) => daemon.id),
                  })}
                >
                  Drain all
                </Button>
                <Button
                  size="xs"
                  disabled={!daemonsWithWorkers.some((daemon) => (daemon.controlState ?? "running") !== "running") || daemonControl.isPending}
                  title="Resume acquisition on every paused or drained daemon"
                  onClick={() => openOperatorAction({
                    kind: "pipeline",
                    pipelineName: "Pipeline",
                    action: "resume",
                    daemonIds: daemonsWithWorkers
                      .filter((daemon) => (daemon.controlState ?? "running") !== "running")
                      .map((daemon) => daemon.id),
                  })}
                >
                  Resume all
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Online daemons" value={onlineCount} />
              <Metric label="Active workers" value={`${workerCount}/${configuredCapacity}`} />
              <Metric label="Idle slots" value={idleWorkers} />
              <Metric label="Stale daemons" value={staleCount} danger={staleCount > 0} />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {capacityByRole.map((capacity) => {
                const presentation = rolePresentation[capacity.role];
                const RoleIcon = presentation.icon;
                return (
                  <Card key={capacity.role} className={`border-l-4 p-3 ${presentation.border} ${presentation.surface}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <RoleIcon className={`h-4 w-4 ${presentation.accent}`} />
                        <div>
                          <p className="text-sm font-semibold">{presentation.label}</p>
                          <p className="text-[11px] text-muted-foreground">{presentation.description}</p>
                        </div>
                      </div>
                      <span className="text-lg font-semibold tabular-nums">{capacity.active}/{capacity.configured}</span>
                    </div>
                    <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground">
                      <span>{capacity.daemonCount} daemons</span>
                      <span>{capacity.idle} idle slots</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        <section aria-labelledby="workers-heading" className="space-y-3">
          <div>
            <h2 id="workers-heading" className="text-base font-semibold">Workers</h2>
            <p className="text-xs text-muted-foreground">Every configured slot is shown, including idle capacity.</p>
          </div>

          {daemonQuery.isError ? (
            <QueryStatePanel
              icon={<AlertTriangle className="h-5 w-5" />}
              title="Daemons could not be loaded"
              description={daemonQuery.error.message}
              onAction={refreshControlPlane}
            />
          ) : daemonQuery.isLoading ? (
            <LoadingCards />
          ) : daemonsWithWorkers.length === 0 ? (
            <QueryStatePanel
              icon={<Bot className="h-5 w-5" />}
              title="No active daemons"
              description="Start a daemon pipeline to expose executor, reviewer, and merger capacity."
            />
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {daemonsWithWorkers.map((daemon) => {
                const role = (daemon.role ?? "executor") as DaemonRole;
                const presentation = rolePresentation[role];
                const RoleIcon = presentation.icon;
                const controlState = daemon.controlState ?? "running";
                const stale = isDaemonStale(daemon.lastHeartbeatAt, now);
                const workers = normalizeWorkerSlots(
                  daemon.workerStates,
                  daemon.workerCapacity ?? 1,
                ) as DaemonWorkerView[];
                const daemonActive = workers.filter((worker) => worker.status !== "idle" || worker.requirementId).length;

                return (
                  <Card key={daemon.id} className={`border-l-4 p-4 ${presentation.border} ${stale ? "opacity-60" : ""}`}>
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${presentation.surface}`}>
                            <RoleIcon className={`h-4 w-4 ${presentation.accent}`} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold">{daemon.name}</span>
                              <Badge variant="outline" className="h-5 px-2 text-[10px] uppercase tracking-wide">{role}</Badge>
                              {controlState !== "running" && (
                                <Badge variant={controlState === "draining" ? "default" : "secondary"} className="h-5 px-2 text-[10px]">
                                  {controlState}
                                </Badge>
                              )}
                              <span className="inline-flex items-center gap-1.5 text-xs capitalize text-muted-foreground">
                                <span className={`h-2 w-2 rounded-full ${statusColor(daemon.status)}`} />
                                {daemon.status}
                              </span>
                              {stale && <Badge variant="destructive" className="h-5 px-2 text-[10px]">stale</Badge>}
                            </div>
                            <p className="mt-1 truncate text-[11px] text-muted-foreground">
                              {daemon.host ?? "unknown host"} · heartbeat {formatRelativeTime(daemon.lastHeartbeatAt, now)}
                            </p>
                          </div>
                        </div>
                        <span className="shrink-0 text-xs font-medium tabular-nums">{daemonActive}/{daemon.workerCapacity ?? 1} active</span>
                      </div>

                      <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                        <span className="truncate font-mono" title={daemon.instanceId}>instance {daemon.instanceId}</span>
                        <span className="truncate font-mono" title={daemon.actorId ?? undefined}>actor {daemon.actorId ?? "legacy / unclaimed"}</span>
                        <span>started {formatDateTime(daemon.processStartedAt)}</span>
                        <span>configured slots {daemon.workerCapacity ?? 1}</span>
                      </div>

                      {daemon.capabilities && daemon.capabilities.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {daemon.capabilities.map((capability: string) => (
                            <Badge key={capability} variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">{capability}</Badge>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/10 p-2">
                        <div className="min-w-0 text-[11px] text-muted-foreground">
                          <p>
                            Acquisition <strong className="text-foreground">{controlState === "running" ? "enabled" : "disabled"}</strong>
                            {controlState === "draining" && daemonActive > 0 ? ` · waiting for ${daemonActive} active worker${daemonActive === 1 ? "" : "s"}` : ""}
                          </p>
                          {daemon.controlReason && <p className="truncate" title={daemon.controlReason}>{daemon.controlReason}</p>}
                        </div>
                        <div className="flex gap-1" aria-label={`Lifecycle controls for ${daemon.name}`}>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={controlState !== "running" || daemonControl.isPending}
                            title={controlState !== "running" ? `Pause is unavailable while ${controlState}` : "Stop new acquisition without interrupting active work"}
                            onClick={() => openOperatorAction({ kind: "daemon", daemonId: daemon.id, daemonName: daemon.name, action: "pause" })}
                          >
                            Pause
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={(controlState !== "running" && controlState !== "paused") || daemonControl.isPending}
                            title={controlState !== "running" && controlState !== "paused" ? `Drain is unavailable while ${controlState}` : "Stop acquisition and wait for active work to finish"}
                            onClick={() => openOperatorAction({ kind: "daemon", daemonId: daemon.id, daemonName: daemon.name, action: "drain" })}
                          >
                            Drain
                          </Button>
                          <Button
                            size="xs"
                            disabled={controlState === "running" || daemonControl.isPending}
                            title={controlState === "running" ? "Daemon is already accepting work" : "Resume acquisition for this daemon"}
                            onClick={() => openOperatorAction({ kind: "daemon", daemonId: daemon.id, daemonName: daemon.name, action: "resume" })}
                          >
                            Resume
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {workers.map((worker) => (
                          <WorkerCard
                            key={worker.index}
                            worker={worker}
                            now={now}
                            onShowTimeline={(requirement) => setTimelineRequirement(requirement)}
                          />
                        ))}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="queues-heading" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="queues-heading" className="text-base font-semibold">Work queues</h2>
              <p className="text-xs text-muted-foreground">Scheduler readiness with dependency, capability, retry, and policy reasons.</p>
            </div>
            {queueQuery.data?.generatedAt && (
              <span className="text-[11px] text-muted-foreground">snapshot {formatRelativeTime(queueQuery.data.generatedAt, now)}</span>
            )}
          </div>

          {queueQuery.isError ? (
            <QueryStatePanel
              icon={<AlertTriangle className="h-5 w-5" />}
              title="Queues could not be loaded"
              description={queueQuery.error.message}
              onAction={refreshControlPlane}
            />
          ) : queueQuery.isLoading ? (
            <LoadingCards />
          ) : (
            <Tabs defaultValue="executor">
              <TabsList className="h-auto max-w-full flex-wrap justify-start" aria-label="Daemon work queues">
                {queueViews.map((view) => {
                  const ViewIcon = view.icon;
                  const count = queueItemsForView(queueItems, view.id).length;
                  return (
                    <TabsTrigger key={view.id} value={view.id}>
                      <ViewIcon className="h-3.5 w-3.5" />
                      {view.label}
                      <span className="rounded bg-muted-foreground/10 px-1.5 text-[10px] tabular-nums">{count}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {queueViews.map((view) => (
                <TabsContent key={view.id} value={view.id}>
                  <QueuePanel
                    items={queueItemsForView(queueItems, view.id)}
                    viewLabel={view.label}
                    now={now}
                    actionsPending={retryDelivery.isPending || manualHandoff.isPending}
                    onRetry={(repository) => openOperatorAction({
                      kind: "retry",
                      linkId: repository.linkId,
                      repositoryName: repository.repositoryName,
                      retryRole: repository.retryRole,
                      retryPhase: repository.retryPhase,
                    })}
                    onHandoff={(repository) => openOperatorAction({
                      kind: "handoff",
                      linkId: repository.linkId,
                      repositoryName: repository.repositoryName,
                      retryRole: repository.retryRole,
                      retryPhase: repository.retryPhase,
                    })}
                    onShowTimeline={(requirement) => setTimelineRequirement(requirement)}
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </section>
      </main>

      <OperatorActionDialog
        action={operatorAction}
        reason={operatorReason}
        onReasonChange={setOperatorReason}
        onOpenChange={(open) => {
          if (!open && !operatorActionPending) {
            setOperatorAction(null);
            setOperatorReason("");
          }
        }}
        onConfirm={() => void submitOperatorAction()}
        pending={operatorActionPending}
      />
      <TimelineDialog
        key={timelineRequirement?.id ?? "timeline-closed"}
        requirement={timelineRequirement}
        onOpenChange={(open) => {
          if (!open) setTimelineRequirement(null);
        }}
      />
    </>
  );
}

function LoadingCards() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {Array.from({ length: 2 }).map((_, index) => (
        <Card key={index} className="flex items-center gap-4 p-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value, danger }: { label: string; value: number | string; danger?: boolean }) {
  return (
    <div className={`rounded-lg border bg-card px-3 py-2 ${danger ? "border-destructive/40" : ""}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${danger ? "text-destructive" : ""}`}>{value}</p>
    </div>
  );
}
