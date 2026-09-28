"use client";

import { useState, useMemo, memo } from "react";
import { trpc } from "@/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  User,
  Calendar,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 40;
const LEFT_WIDTH = 320;
const MAX_TICKS = 8000;

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { bar: string; fill: string; badge: string; label: string }
> = {
  todo: {
    bar: "bg-slate-200 dark:bg-slate-700",
    fill: "bg-slate-400 dark:bg-slate-500",
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    label: "Todo",
  },
  in_progress: {
    bar: "bg-blue-100 dark:bg-blue-900/50",
    fill: "bg-blue-500 dark:bg-blue-400",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    label: "In Progress",
  },
  in_review: {
    bar: "bg-amber-100 dark:bg-amber-900/50",
    fill: "bg-amber-500 dark:bg-amber-400",
    badge: "bg-amber-50 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    label: "In Review",
  },
  done: {
    bar: "bg-emerald-100 dark:bg-emerald-900/50",
    fill: "bg-emerald-500 dark:bg-emerald-400",
    badge:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    label: "Done",
  },
  cancelled: {
    bar: "bg-red-100/60 dark:bg-red-900/30",
    fill: "bg-red-400 dark:bg-red-500",
    badge: "bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-300",
    label: "Cancelled",
  },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.todo;
}

// ── Zoom infrastructure ───────────────────────────────────────────────────────

const ZOOM_LEVELS = [
  "year",
  "month",
  "week",
  "day",
  "hour",
  "minute",
] as const;
type ZoomLevel = (typeof ZOOM_LEVELS)[number];

const DEFAULT_ZOOM: ZoomLevel = "week";

interface ZoomConfig {
  label: string;
  unitMs: number;
  unitWidth: number;
  /** true for hour/minute zoom — controls bar tooltip formatting and grid rendering */
  isSubDay: boolean;
  floorToUnit: (ts: number) => number;
  floorToGroup: (ts: number) => number;
  formatTick: (d: Date) => string;
  formatGroup: (d: Date) => string;
}

// -- floor helpers --

function floorToLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function floorToLocalMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function floorToHour(ts: number): number {
  const d = new Date(ts);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
  ).getTime();
}

function floorTo15Min(ts: number): number {
  const d = new Date(ts);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    Math.floor(d.getMinutes() / 15) * 15,
  ).getTime();
}

function floorToMin(ts: number): number {
  const d = new Date(ts);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
  ).getTime();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const ZOOM_CONFIGS: Record<ZoomLevel, ZoomConfig> = {
  year: {
    label: "Year",
    unitMs: 86_400_000,
    unitWidth: 4,
    isSubDay: false,
    floorToUnit: floorToLocalDay,
    floorToGroup: floorToLocalMonth,
    formatTick: () => "",
    formatGroup: (d) =>
      d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
  },
  month: {
    label: "Month",
    unitMs: 86_400_000,
    unitWidth: 12,
    isSubDay: false,
    floorToUnit: floorToLocalDay,
    floorToGroup: floorToLocalMonth,
    // Only show label on Mondays to avoid crowding at 12px/day
    formatTick: (d) => (d.getDay() === 1 ? String(d.getDate()) : ""),
    formatGroup: (d) =>
      d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
  },
  week: {
    label: "Week",
    unitMs: 86_400_000,
    unitWidth: 32,
    isSubDay: false,
    floorToUnit: floorToLocalDay,
    floorToGroup: floorToLocalMonth,
    formatTick: (d) => String(d.getDate()),
    formatGroup: (d) =>
      d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
  },
  day: {
    label: "Day",
    unitMs: 3_600_000,
    unitWidth: 40,
    isSubDay: true,
    floorToUnit: floorToHour,
    floorToGroup: floorToLocalDay,
    // Label every 6 hours
    formatTick: (d) => (d.getHours() % 6 === 0 ? `${d.getHours()}h` : ""),
    formatGroup: (d) =>
      d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
  },
  hour: {
    label: "Hour",
    unitMs: 15 * 60_000,
    unitWidth: 20,
    isSubDay: true,
    floorToUnit: floorTo15Min,
    floorToGroup: floorToHour,
    // Full time at :00, short ":30" at half-hour, blank otherwise
    formatTick: (d) =>
      d.getMinutes() === 0
        ? `${d.getHours()}:00`
        : d.getMinutes() === 30
          ? ":30"
          : "",
    formatGroup: (d) =>
      `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad2(d.getHours())}:00`,
  },
  minute: {
    label: "Min",
    unitMs: 60_000,
    unitWidth: 3,
    isSubDay: true,
    floorToUnit: floorToMin,
    floorToGroup: floorToHour,
    // Label every 15 minutes
    formatTick: (d) =>
      d.getMinutes() % 15 === 0
        ? `${d.getHours()}:${pad2(d.getMinutes())}`
        : "",
    formatGroup: (d) =>
      `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad2(d.getHours())}:00`,
  },
};

// ── Timeline types & builder ──────────────────────────────────────────────────

interface TickColumn {
  ts: number;
  date: Date;
  label: string;
  isWeekend: boolean;
}

interface GroupSpan {
  label: string;
  startTick: number;
  span: number;
}

interface Timeline {
  startMs: number;
  ticks: TickColumn[];
  groups: GroupSpan[];
  totalWidth: number;
  /** Exact pixel offset of the current moment from timeline start (null if off-range) */
  nowPx: number | null;
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function buildTimeline(
  startIso: string,
  endIso: string,
  zoom: ZoomLevel,
): Timeline | null {
  const cfg = ZOOM_CONFIGS[zoom];
  const dataStart = new Date(startIso).getTime();
  const dataEnd = new Date(endIso).getTime();
  if (isNaN(dataStart) || isNaN(dataEnd) || dataEnd < dataStart) return null;

  const timelineStart = cfg.floorToUnit(dataStart - cfg.unitMs * 2);
  const rawEnd = cfg.floorToUnit(dataEnd) + cfg.unitMs * 4;
  const totalCount = Math.ceil((rawEnd - timelineStart) / cfg.unitMs);
  const count = Math.min(totalCount, MAX_TICKS);

  const ticks: TickColumn[] = [];
  const groups: GroupSpan[] = [];
  let curGroupTs = -1;

  for (let i = 0; i < count; i++) {
    const ts = timelineStart + i * cfg.unitMs;
    const d = new Date(ts);
    const groupTs = cfg.floorToGroup(ts);

    if (groupTs !== curGroupTs) {
      if (groups.length > 0) {
        groups[groups.length - 1].span =
          ticks.length - groups[groups.length - 1].startTick;
      }
      groups.push({
        label: cfg.formatGroup(new Date(groupTs)),
        startTick: ticks.length,
        span: 0,
      });
      curGroupTs = groupTs;
    }

    ticks.push({
      ts,
      date: d,
      label: cfg.formatTick(d),
      isWeekend: !cfg.isSubDay && isWeekend(d),
    });
  }

  if (groups.length > 0) {
    groups[groups.length - 1].span =
      ticks.length - groups[groups.length - 1].startTick;
  }

  const nowMs = Date.now();
  const timelineEnd = timelineStart + count * cfg.unitMs;
  const nowPx =
    nowMs >= timelineStart && nowMs < timelineEnd
      ? ((nowMs - timelineStart) / cfg.unitMs) * cfg.unitWidth
      : null;

  return {
    startMs: timelineStart,
    ticks,
    groups,
    totalWidth: count * cfg.unitWidth,
    nowPx,
  };
}

function computeBarPosition(
  startIso: string,
  endIso: string,
  timeline: Timeline,
  cfg: ZoomConfig,
): { left: number; width: number } {
  const taskStart = new Date(startIso).getTime();
  const taskEnd = new Date(endIso).getTime();
  const durationMs = Math.max(taskEnd - taskStart, cfg.unitMs);
  const left =
    Math.max(0, ((taskStart - timeline.startMs) / cfg.unitMs) * cfg.unitWidth) +
    1;
  const width = Math.max((durationMs / cfg.unitMs) * cfg.unitWidth - 2, 4);
  return { left, width };
}

function formatDateTime(iso: string, isSubDay: boolean): string {
  const d = new Date(iso);
  if (isSubDay) {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface GanttTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  requirementId: string;
  requirementTitle: string;
  startDate: string;
  endDate: string;
  estimated: boolean;
  progress: number;
  dependencies: { taskId: string; type: string }[];
}

interface TaskGroup {
  id: string;
  title: string;
  tasks: GanttTask[];
}

type RowOrder = "asc" | "desc";

function taskStartMs(task: GanttTask): number {
  const start = new Date(task.startDate).getTime();
  if (Number.isFinite(start)) return start;
  const end = new Date(task.endDate).getTime();
  return Number.isFinite(end) ? end : 0;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function GanttSkeleton({ title = "Gantt Chart" }: { title?: string }) {
  const barWidths = [45, 30, 55, 40, 60, 35, 50, 25];
  const barOffsets = [5, 15, 10, 20, 8, 12, 3, 18];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="flex gap-3">
            <Skeleton className="h-[52px] w-[320px] shrink-0 rounded-md" />
            <Skeleton className="h-[52px] flex-1 rounded-md" />
          </div>
          {barWidths.map((w, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-10 w-[320px] shrink-0 rounded-md" />
              <div className="flex-1 flex items-center">
                <Skeleton
                  className="h-6 rounded-md"
                  style={{ width: `${w}%`, marginLeft: `${barOffsets[i]}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ title = "Gantt Chart" }: { title?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Calendar className="h-12 w-12 mb-3 opacity-30" />
          <p className="text-base font-medium">No tasks to display</p>
          <p className="text-sm mt-1">
            Add tasks with start and end dates to see the timeline.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Renders the vertical column lines for the timeline body.
 *
 * For sub-day zoom levels (many ticks), a CSS repeating-gradient is used
 * instead of individual divs to avoid rendering thousands of DOM elements.
 */
const TimelineGrid = memo(function TimelineGrid({
  ticks,
  unitWidth,
  isSubDay,
}: {
  ticks: TickColumn[];
  unitWidth: number;
  isSubDay: boolean;
}) {
  if (isSubDay) {
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `repeating-linear-gradient(to right, transparent 0px, transparent ${unitWidth - 1}px, color-mix(in oklab, var(--border) 20%, transparent) ${unitWidth - 1}px, color-mix(in oklab, var(--border) 20%, transparent) ${unitWidth}px)`,
        }}
      />
    );
  }
  return (
    <div className="absolute inset-0 flex pointer-events-none">
      {ticks.map((tick, i) => (
        <div
          key={i}
          className={cn(
            "h-full shrink-0 border-r border-border/20",
            tick.isWeekend && "bg-muted/40",
          )}
          style={{ width: unitWidth }}
        />
      ))}
    </div>
  );
});

const NowMarker = memo(function NowMarker({ pxOffset }: { pxOffset: number }) {
  return (
    <div
      className="absolute top-0 bottom-0 z-[3] pointer-events-none"
      style={{ left: Math.round(pxOffset) - 1, width: 2 }}
    >
      <div className="h-full w-full rounded-full bg-blue-500 dark:bg-blue-400 opacity-70" />
    </div>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

export function GanttChart({
  projectId,
  requirementId,
  title = "Gantt Chart",
}: {
  projectId: string;
  requirementId?: string;
  title?: string;
}) {
  const { data, isLoading, error } = trpc.task.gantt.useQuery({ projectId });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState<ZoomLevel>(DEFAULT_ZOOM);
  const [rowOrder, setRowOrder] = useState<RowOrder>("desc");

  const cfg = ZOOM_CONFIGS[zoom];
  const zoomIdx = ZOOM_LEVELS.indexOf(zoom);
  const rowOrderLabel = rowOrder === "desc" ? "Newest first" : "Oldest first";

  const dataTasks = useMemo(() => {
    const tasks = data?.tasks ?? [];
    if (!requirementId) return tasks;
    return tasks.filter((task) => task.requirementId === requirementId);
  }, [data?.tasks, requirementId]);

  const dateRange = useMemo(() => {
    if (dataTasks.length === 0) return null;
    const dates = dataTasks.flatMap((task) => [
      new Date(task.startDate).getTime(),
      new Date(task.endDate).getTime(),
    ]);
    return {
      start: new Date(Math.min(...dates)).toISOString(),
      end: new Date(Math.max(...dates)).toISOString(),
    };
  }, [dataTasks]);

  const timeline = useMemo(() => {
    if (!dateRange) return null;
    return buildTimeline(dateRange.start, dateRange.end, zoom);
  }, [dateRange, zoom]);

  const groups = useMemo<TaskGroup[]>(() => {
    const map = new Map<string, TaskGroup>();
    for (const t of dataTasks) {
      let group = map.get(t.requirementId);
      if (!group) {
        group = { id: t.requirementId, title: t.requirementTitle, tasks: [] };
        map.set(t.requirementId, group);
      }
      group.tasks.push(t);
    }
    const grouped = Array.from(map.values()).map((group) => ({
      group: {
        ...group,
        tasks: [...group.tasks].sort(
          (a, b) => taskStartMs(a) - taskStartMs(b) || a.title.localeCompare(b.title),
        ),
      },
      firstTaskAt: Math.min(...group.tasks.map(taskStartMs)),
      lastTaskAt: Math.max(...group.tasks.map(taskStartMs)),
    }));

    grouped.sort((a, b) => {
      const diff =
        rowOrder === "asc"
          ? a.firstTaskAt - b.firstTaskAt
          : b.lastTaskAt - a.lastTaskAt;
      return diff !== 0 ? diff : a.group.title.localeCompare(b.group.title);
    });

    return grouped.map(({ group }) => ({
      ...group,
      tasks: rowOrder === "asc" ? group.tasks : [...group.tasks].reverse(),
    }));
  }, [dataTasks, rowOrder]);

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  if (isLoading) return <GanttSkeleton title={title} />;

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-16 text-destructive">
            <p className="text-base font-medium">Failed to load chart</p>
            <p className="text-sm mt-1 text-muted-foreground">
              {error.message}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data || !timeline || dataTasks.length === 0) return <EmptyState title={title} />;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            {title}
          </CardTitle>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => setRowOrder((value) => (value === "desc" ? "asc" : "desc"))}
              title={`Rows: ${rowOrderLabel}`}
            >
              {rowOrder === "desc" ? (
                <ArrowDown className="h-3.5 w-3.5" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{rowOrderLabel}</span>
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoom(ZOOM_LEVELS[zoomIdx - 1])}
              disabled={zoomIdx === 0}
              title="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs font-medium text-muted-foreground w-10 text-center tabular-nums select-none">
              {cfg.label}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoom(ZOOM_LEVELS[zoomIdx + 1])}
              disabled={zoomIdx === ZOOM_LEVELS.length - 1}
              title="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <TooltipProvider delayDuration={150}>
          <div className="overflow-auto max-h-[calc(100vh-220px)] border-t">
            <div style={{ minWidth: LEFT_WIDTH + timeline.totalWidth }}>
              {/* ================================================================
                  Header (sticky)
                  ================================================================ */}
              <div className="sticky top-0 z-20 flex border-b bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                {/* Left header cell */}
                <div
                  className="sticky left-0 z-30 shrink-0 flex items-end pb-2 px-4 border-r bg-card text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  style={{ width: LEFT_WIDTH, height: 52 }}
                >
                  Task
                </div>

                {/* Timeline header */}
                <div style={{ width: timeline.totalWidth }}>
                  {/* Group row (coarser: month / day / hour) */}
                  <div className="flex h-6">
                    {timeline.groups.map((g, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-center text-[11px] font-semibold text-muted-foreground border-r border-border/40 overflow-hidden"
                        style={{ width: g.span * cfg.unitWidth }}
                      >
                        {g.span * cfg.unitWidth > 48 ? g.label : ""}
                      </div>
                    ))}
                  </div>

                  {/* Tick row (finer: day / 15min / 1min) */}
                  {cfg.isSubDay ? (
                    // Absolutely-positioned labels for sub-day zoom to avoid
                    // rendering thousands of empty divs
                    <div
                      className="relative h-[26px]"
                      style={{ width: timeline.totalWidth }}
                    >
                      <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          backgroundImage: `repeating-linear-gradient(to right, transparent 0px, transparent ${cfg.unitWidth - 1}px, color-mix(in oklab, var(--border) 30%, transparent) ${cfg.unitWidth - 1}px, color-mix(in oklab, var(--border) 30%, transparent) ${cfg.unitWidth}px)`,
                        }}
                      />
                      {timeline.ticks
                        .map((tick, i) => ({ tick, i }))
                        .filter(({ tick }) => tick.label !== "")
                        .map(({ tick, i }) => (
                          <span
                            key={tick.ts}
                            className="absolute flex items-center text-[10px] tabular-nums text-muted-foreground/70 whitespace-nowrap"
                            style={{ top: 4, left: i * cfg.unitWidth + 2 }}
                          >
                            {tick.label}
                          </span>
                        ))}
                    </div>
                  ) : (
                    <div className="flex h-[26px]">
                      {timeline.ticks.map((tick, i) => (
                        <div
                          key={i}
                          className={cn(
                            "flex items-center justify-center text-[10px] shrink-0 border-r border-border/30 tabular-nums overflow-hidden",
                            tick.isWeekend
                              ? "text-muted-foreground/40 bg-muted/40"
                              : "text-muted-foreground/70",
                          )}
                          style={{ width: cfg.unitWidth }}
                        >
                          {tick.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ================================================================
                  Body rows
                  ================================================================ */}
              {groups.map((group) => {
                const isCollapsed = !!collapsed[group.id];

                return (
                  <div key={group.id}>
                    {/* ── Requirement group header ── */}
                    <div className="flex border-b bg-muted/50 dark:bg-muted/20">
                      <div
                        className="sticky left-0 z-10 shrink-0 border-r bg-muted/50 dark:bg-muted/20"
                        style={{ width: LEFT_WIDTH }}
                      >
                        <button
                          onClick={() => toggle(group.id)}
                          className="flex items-center gap-2 w-full px-3 text-sm font-medium hover:bg-muted/80 dark:hover:bg-muted/40 transition-colors"
                          style={{ height: ROW_HEIGHT }}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{group.title}</span>
                          <Badge
                            variant="secondary"
                            className="ml-auto text-[10px] tabular-nums px-1.5 py-0 h-4"
                          >
                            {group.tasks.length}
                          </Badge>
                        </button>
                      </div>

                      <div
                        className="relative"
                        style={{
                          width: timeline.totalWidth,
                          height: ROW_HEIGHT,
                        }}
                      >
                        <TimelineGrid
                          ticks={timeline.ticks}
                          unitWidth={cfg.unitWidth}
                          isSubDay={cfg.isSubDay}
                        />
                        {timeline.nowPx !== null && (
                          <NowMarker pxOffset={timeline.nowPx} />
                        )}
                      </div>
                    </div>

                    {/* ── Task rows ── */}
                    {!isCollapsed &&
                      group.tasks.map((task, idx) => {
                        const statusCfg = getStatusConfig(task.status);
                        const bar = computeBarPosition(
                          task.startDate,
                          task.endDate,
                          timeline,
                          cfg,
                        );
                        const progress = Math.min(
                          100,
                          Math.max(0, task.progress),
                        );
                        const isCancelled = task.status === "cancelled";

                        return (
                          <div
                            key={task.id}
                            className="flex border-b group/row"
                          >
                            {/* Left cell */}
                            <div
                              className={cn(
                                "sticky left-0 z-10 shrink-0 border-r transition-colors",
                                idx % 2 === 0
                                  ? "bg-card group-hover/row:bg-accent/50"
                                  : "bg-card/80 group-hover/row:bg-accent/50",
                              )}
                              style={{ width: LEFT_WIDTH }}
                            >
                              <div
                                className="flex items-center gap-2.5 px-4 pl-10"
                                style={{ height: ROW_HEIGHT }}
                              >
                                <span
                                  className={cn(
                                    "h-2 w-2 rounded-full shrink-0",
                                    statusCfg.fill,
                                  )}
                                />
                                <span
                                  className={cn(
                                    "text-sm truncate flex-1 min-w-0",
                                    isCancelled &&
                                      "line-through text-muted-foreground",
                                  )}
                                  title={task.title}
                                >
                                  {task.title}
                                </span>
                                {task.assignee && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="shrink-0 text-muted-foreground">
                                        <User className="h-3.5 w-3.5" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="right"
                                      className="text-xs"
                                    >
                                      {task.assignee}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </div>

                            {/* Timeline cell */}
                            <div
                              className={cn(
                                "relative transition-colors",
                                idx % 2 === 1 && "bg-muted/[0.04]",
                                "group-hover/row:bg-accent/10",
                              )}
                              style={{
                                width: timeline.totalWidth,
                                height: ROW_HEIGHT,
                              }}
                            >
                              <TimelineGrid
                                ticks={timeline.ticks}
                                unitWidth={cfg.unitWidth}
                                isSubDay={cfg.isSubDay}
                              />
                              {timeline.nowPx !== null && (
                                <NowMarker pxOffset={timeline.nowPx} />
                              )}

                              {/* Task bar */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className={cn(
                                      "absolute top-[8px] h-6 rounded-[5px] z-[2] cursor-pointer",
                                      "hover:ring-2 hover:ring-black/10 dark:hover:ring-white/15",
                                      "shadow-sm hover:shadow-md transition-shadow",
                                      statusCfg.bar,
                                      task.estimated
                                        ? "border border-dashed border-current/20 opacity-80"
                                        : "ring-1 ring-black/[0.06] dark:ring-white/[0.08]",
                                      isCancelled && "opacity-50",
                                    )}
                                    style={{
                                      left: bar.left,
                                      width: bar.width,
                                    }}
                                  >
                                    {/* Progress fill */}
                                    <div
                                      className={cn(
                                        "absolute inset-y-0 left-0 transition-all",
                                        progress >= 100
                                          ? "rounded-[5px]"
                                          : "rounded-l-[5px]",
                                        statusCfg.fill,
                                        task.estimated && "opacity-60",
                                      )}
                                      style={{ width: `${progress}%` }}
                                    />
                                    {/* Inline label on wider bars */}
                                    {bar.width >= 80 && (
                                      <span className="relative z-[1] flex items-center h-full px-2 text-[10px] font-medium text-foreground/70 truncate">
                                        {task.title}
                                      </span>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="top"
                                  sideOffset={6}
                                  className="p-0 w-64"
                                >
                                  <div className="p-3 space-y-2.5">
                                    <p className="font-semibold text-sm leading-tight">
                                      {task.title}
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                      <span
                                        className={cn(
                                          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                                          statusCfg.badge,
                                        )}
                                      >
                                        {statusCfg.label}
                                      </span>
                                      {task.priority && (
                                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize">
                                          {task.priority}
                                        </span>
                                      )}
                                      {task.estimated && (
                                        <span className="inline-flex items-center rounded-full border border-dashed px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                          Estimated
                                        </span>
                                      )}
                                    </div>
                                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                                      <span className="text-muted-foreground">
                                        Start
                                      </span>
                                      <span>
                                        {formatDateTime(
                                          task.startDate,
                                          cfg.isSubDay,
                                        )}
                                      </span>
                                      <span className="text-muted-foreground">
                                        {task.estimated ? "Expected" : "End"}
                                      </span>
                                      <span>
                                        {formatDateTime(
                                          task.endDate,
                                          cfg.isSubDay,
                                        )}
                                      </span>
                                      {task.assignee && (
                                        <>
                                          <span className="text-muted-foreground">
                                            Assignee
                                          </span>
                                          <span>{task.assignee}</span>
                                        </>
                                      )}
                                    </div>
                                    <div className="space-y-1">
                                      <div className="flex justify-between text-[10px] text-muted-foreground">
                                        <span>Progress</span>
                                        <span className="tabular-nums">
                                          {progress}%
                                        </span>
                                      </div>
                                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                        <div
                                          className={cn(
                                            "h-full rounded-full",
                                            statusCfg.fill,
                                          )}
                                          style={{ width: `${progress}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
