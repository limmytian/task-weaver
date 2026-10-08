"use client";

import { ExecutorProfiles } from "./executor-profiles";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Clock3,
  ExternalLink,
  GitBranch,
  GitMerge,
  History,
  ListChecks,
  MapPinned,
  RefreshCw,
  SearchCheck,
  ServerCog,
  ShieldAlert,
  UserRoundCog,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { useRealtime } from "@/hooks/use-realtime";
import { QueryStatePanel } from "@/components/query-state-panel";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  normalizeWorkerSlots,
  isDaemonStale,
  isLeaseAtRisk,
  queueItemsForView,
  summarizeRoleCapacity,
  type DaemonRole,
} from "./control-plane";

function statusColor(status: string) {
  if (status === "idle") return "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
  if (status === "busy") return "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]";
  return "bg-slate-400";
}

function formatRelativeTime(date: Date | string | null | undefined, now: number) {
  if (!date) return "—";
  const diffSeconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return `${Math.round(diffMinutes / 60)}h ago`;
}

function formatDateTime(date: Date | string | null | undefined) {
  return date ? new Date(date).toLocaleString() : "—";
}

function taskBadgeVariant(status: string) {
  if (status === "done") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "in_progress") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "in_review") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (status === "ready_to_merge") return "bg-cyan-50 text-cyan-700 border-cyan-200";
  if (status === "cancelled") return "bg-slate-100 text-slate-500 border-slate-200";
  return "bg-background text-muted-foreground border-border";
}

function sloStatusClass(status: string) {
  if (status === "pass") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "breach") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function sloTarget(metric: { unit: string; comparator: string; target: number }) {
  const value = metric.unit === "ratio"
    ? `${(metric.target * 100).toFixed(0)}%`
    : metric.unit === "seconds"
      ? `${metric.target}s`
      : String(metric.target);
  return `${metric.comparator === "lte" ? "≤" : "≥"} ${value}`;
}

const requirementStatusLabels: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In Progress",
  in_review: "In Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

const rolePresentation = {
  executor: {
    label: "Executors",
    description: "Implementation and task execution",
    icon: Bot,
    accent: "text-indigo-600",
    border: "border-l-indigo-500",
    surface: "bg-indigo-50/60 dark:bg-indigo-950/20",
  },
  reviewer: {
    label: "Reviewers",
    description: "Verification and review decisions",
    icon: SearchCheck,
    accent: "text-fuchsia-600",
    border: "border-l-fuchsia-500",
    surface: "bg-fuchsia-50/60 dark:bg-fuchsia-950/20",
  },
  merger: {
    label: "Mergers",
    description: "Delivery and merge completion",
    icon: GitMerge,
    accent: "text-cyan-600",
    border: "border-l-cyan-500",
    surface: "bg-cyan-50/60 dark:bg-cyan-950/20",
  },
} as const;

type DaemonRoadmapTask = {
  id: string;
  title: string;
  status: string;
};

type DaemonWorkerView = {
  index: number;
  status: string;
  requirementId?: string | null;
  executionSliceId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  modelTier?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  worktreePath?: string | null;
  progressPhase?: string | null;
  leaseGeneration?: number | null;
  leaseHealthy?: boolean | null;
  leaseHeartbeatFailures?: number | null;
  lastLeaseError?: string | null;
  executionSlice?: { id: string; title: string } | null;
  progress?: {
    phase: string;
    message?: string | null;
    workspaceState?: string | null;
    recoveryDisposition?: string | null;
    retryCount?: number | null;
    handoffSummary?: string | null;
    lastEventAt?: Date | string | null;
  } | null;
  requirement?: {
    id: string;
    title: string;
    status: string;
    branchName?: string | null;
  } | null;
  roadmap?: DaemonRoadmapTask[];
  claim?: {
    expiresAt?: Date | string | null;
    heartbeatAt?: Date | string | null;
    generation?: number | null;
  } | null;
};

type DaemonQueueView = {
  requirementId: string;
  projectId: string;
  projectName: string;
  title: string;
  requirementStatus: string;
  priority: string;
  role: DaemonRole | "operator";
  state: "runnable" | "blocked" | "retrying" | "manual";
  reasonCodes: string[];
  reasons: string[];
  taskId: string | null;
  taskTitle: string | null;
  executionSliceId: string | null;
  executionSliceTitle: string | null;
  retryCount: number;
  nextAttemptAt: Date | string | null;
  failureCode: string | null;
  failureSummary: string | null;
  repositories: Array<{
    linkId: string;
    repositoryId: string;
    repositoryName: string;
    repositoryKey: string;
    deliveryStatus: string;
    failureCode: string | null;
    failureSummary: string | null;
    retryCount: number;
    retryRole: DaemonRole | null;
    retryPolicy: "automatic" | "after_follow_up" | "manual" | null;
    retryExhausted: boolean;
    retryPhase: "execution" | "review" | "merge" | null;
    nextAttemptAt: Date | string | null;
  }>;
  updatedAt: Date | string;
};

type OperatorAction =
  | {
      kind: "daemon";
      daemonId: string;
      daemonName: string;
      action: "pause" | "drain" | "resume";
    }
  | {
      kind: "pipeline";
      daemonIds: string[];
      pipelineName: string;
      action: "pause" | "drain" | "resume";
    }
  | {
      kind: "retry" | "handoff";
      linkId: string;
      repositoryName: string;
      retryRole: DaemonRole | null;
      retryPhase: "execution" | "review" | "merge" | null;
    };

type TimelineRequirement = { id: string; title: string };

const queueViews = [
  { id: "executor", label: "Executor", icon: Bot },
  { id: "reviewer", label: "Review", icon: SearchCheck },
  { id: "merger", label: "Merge", icon: GitMerge },
  { id: "retrying", label: "Retry", icon: Clock3 },
  { id: "blocked", label: "Blocked", icon: ShieldAlert },
  { id: "manual", label: "Manual", icon: UserRoundCog },
] as const;

export default function DaemonsPage() {
  const realtime = useRealtime();
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

function WorkerCard({
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

function QueuePanel({
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

function TimelineDialog({
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

function OperatorActionDialog({
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
