"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, CheckCircle2, ClipboardList, Clock, EyeOff, Filter, User } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { DeferredTaskDetailSheet as TaskDetailSheet } from "./deferred-task-detail-sheet";
import { Button } from "@/components/ui/button";
import { QueryStatePanel } from "@/components/query-state-panel";
import { resourceAccessLost } from "@/lib/resource-access";
import { RequirementPicker } from "./requirement-picker";
import { RepositoryChips } from "./repository-links";

const priorityColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  low: "outline",
  medium: "secondary",
  high: "default",
  urgent: "destructive",
};

const columnColors: Record<string, string> = {
  todo: "bg-muted-foreground/20",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  done: "bg-green-500",
  cancelled: "bg-destructive",
  low: "bg-muted-foreground/30",
  medium: "bg-blue-400",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};

type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
type GroupBy = "status" | "priority" | "assignee";

interface BoardTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  assignee: string | null;
  tags: string[] | null;
  expectedAt: Date | string | null;
  requirementId: string;
  requirementTitle: string;
  requirementStatus: string | null;
  repositories: Array<{
    repository: {
      id: string;
      displayName: string;
      canonicalKey: string;
      provider: string;
    };
  }>;
}


function getExpectedAtInfo(expectedAt: Date | string | null): { label: string; className: string } | null {
  if (!expectedAt) return null;
  const due = new Date(expectedAt);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const label = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  if (diffDays < 0) return { label, className: "text-destructive" };
  if (diffDays <= 3) return { label, className: "text-amber-600 dark:text-amber-400" };
  return { label, className: "text-muted-foreground" };
}

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

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

const priorityLabels: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const REQ_COLORS = [
  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-pink-500/15 text-pink-700 dark:text-pink-300",
];

export function KanbanBoard({
  projectId,
  initialTaskId,
  onTaskClick: externalOnTaskClick,
  readOnly = false,
}: {
  projectId: string;
  readOnly?: boolean;
  initialTaskId?: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId ?? null);
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [scopeReqId, setScopeReqId] = useState<string>("__all__");
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [showTerminalColumns, setShowTerminalColumns] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const isMobile = useIsMobile();
  const boardQueryInput = useMemo(() => ({
    projectId, groupBy, requirementId: scopeReqId === "__all__" ? undefined : scopeReqId,
    includeTerminal: showTerminalColumns,
    completedWithinDays: showTerminalColumns && showAllCompleted ? 0 : 14,
  }), [projectId, groupBy, scopeReqId, showAllCompleted, showTerminalColumns]);
  const result = trpc.task.boardColumns.useQuery(boardQueryInput);
  const board = result.isError ? undefined : result.data;
  const utils = trpc.useUtils();

  const handleTaskClick = externalOnTaskClick ?? ((id: string) => setSelectedTaskId(id));
  const managesOwnSheet = !externalOnTaskClick;

  const updateStatus = trpc.task.updateStatus.useMutation({
    onError: () => toast.error("Failed to update task status"),
    onSettled: () => {
      utils.task.board.invalidate({ projectId });
      utils.task.boardPage.invalidate({ projectId });
      utils.task.boardColumns.invalidate({ projectId });
      utils.task.boardColumn.invalidate({ projectId });
      utils.requirement.list.invalidate({ projectId });
      utils.requirement.listSummary.invalidate({ projectId });
      utils.task.gantt.invalidate({ projectId });
    },
  });

  const columns = useMemo(() => {
    if (!board) return [];
    const counts = board.columns;
    const values = groupBy === "status" ? (showTerminalColumns
      ? ["todo", "in_progress", "in_review", "done", "cancelled"] : ["todo", "in_progress", "in_review"])
      : groupBy === "priority" ? ["urgent", "high", "medium", "low"]
      : counts.map(row => row.value).sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b));
    return values.map(value => ({ key: JSON.stringify(value), value,
      label: value === null ? "Unassigned" : groupBy === "status" ? statusLabels[value] ?? value
        : groupBy === "priority" ? priorityLabels[value] ?? value : value,
      total: counts.find(row => row.value === value)?.total ?? 0 }));
  }, [board, groupBy, showTerminalColumns]);
  const reqColorMap = useMemo(() => new Map<string, string>(activeTask ? [[activeTask.requirementId, REQ_COLORS[[...activeTask.requirementId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % REQ_COLORS.length]]] : []), [activeTask]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    if (readOnly) return;
    const task = event.active.data.current?.task as BoardTask | undefined;
    if (task) setActiveTask(task);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (readOnly || !over) return;

    const taskId = active.id as string;
    const targetColumn = over.id as string;
    const task = active.data.current?.task as BoardTask | undefined;

    if (!task || task.status === "cancelled") return;

    if (groupBy === "status" && task.status !== targetColumn) {
      updateStatus.mutate({ id: taskId, status: targetColumn as TaskStatus });
    }
  };

  return (
    <>
      <div className="mb-3 grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Group by</span>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="h-10 min-w-0 flex-1 text-xs sm:h-7 sm:w-32 sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="assignee">Assignee</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2 min-w-0 space-y-2 sm:col-auto sm:max-w-sm">
          <Button type="button" variant="outline" size="sm" aria-expanded={filterOpen}
            onClick={() => setFilterOpen(open => !open)}>
            <Filter className="mr-1 h-3 w-3" />{scopeReqId === "__all__" ? "All Requirements" : "Requirement filter active"}
          </Button>
          {filterOpen && <RequirementPicker key={projectId} projectId={projectId} value={scopeReqId}
            invalid={false} allowAll includeCancelled includeHistory onValueChange={id => { setScopeReqId(id); }} />}
        </div>

        <button
          onClick={() => { setShowTerminalColumns(v => !v); }}
          className={cn(
            "flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors sm:min-h-7",
            showTerminalColumns
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={showTerminalColumns ? "Hide done and cancelled tasks" : "Show done and cancelled tasks"}
        >
          {showTerminalColumns ? <CheckCircle2 className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {showTerminalColumns ? "Terminal shown" : "Terminal hidden"}
        </button>

        {showTerminalColumns && (
          <button
            onClick={() => { setShowAllCompleted(v => !v); }}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors sm:ml-auto sm:min-h-7",
              showAllCompleted
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Clock className="h-3 w-3" />
            {showAllCompleted ? "All completed" : "Recent 14d"}
          </button>
        )}

        <span className="text-right text-xs text-muted-foreground tabular-nums sm:text-left">
          {board ? `${board.total} matching tasks` : "Loading tasks..."}
        </span>
        {isMobile && groupBy === "status" && (
          <span className="col-span-2 text-xs text-muted-foreground">
            Open a task to change its status. Dragging is paused on touch screens.
          </span>
        )}
      </div>

      {result.isError && <QueryStatePanel title="Board could not be loaded" onAction={() => result.refetch()} />}
      {result.isPending && <Skeleton className="h-96 w-full rounded-xl" />}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <ScrollArea className="w-full">
          <div className="flex snap-x snap-mandatory gap-3 pb-4 sm:gap-4">
            {columns.map((column) => (
              <KanbanColumn
                key={`${JSON.stringify(boardQueryInput)}:${column.key}`}
                input={boardQueryInput}
                columnKey={column.value ?? "__unassigned__"}
                value={column.value}
                label={column.label}
                count={column.total}
                enabled={!!board}
                droppable={groupBy === "status" && !isMobile && !updateStatus.isPending}
                onTaskClick={handleTaskClick}
                showReqLabel={scopeReqId === "__all__"}
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <DragOverlay>
          {activeTask ? <TaskCardOverlay task={activeTask} reqColorMap={reqColorMap} /> : null}
        </DragOverlay>
      </DndContext>

      {managesOwnSheet && (
        <TaskDetailSheet
          taskId={selectedTaskId}
          projectId={projectId}
          open={!!selectedTaskId}
          onOpenChange={(open) => {
            if (!open) setSelectedTaskId(null);
          }}
          onTaskSelect={setSelectedTaskId}
        />
      )}
    </>
  );
}

type BoardColumnFilters = { projectId: string; groupBy: GroupBy; requirementId?: string; includeTerminal: boolean; completedWithinDays: number };

function KanbanColumn({
  input, columnKey, value, label, count, enabled, droppable, onTaskClick, showReqLabel,
}: {
  input: BoardColumnFilters;
  columnKey: string;
  value: string | null;
  label: string;
  count: number;
  enabled: boolean;
  droppable: boolean;
  onTaskClick: (id: string) => void;
  showReqLabel: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const query = trpc.task.boardColumn.useInfiniteQuery({ ...input, value, pageSize: 20 }, {
    enabled: enabled && visible && count > 0,
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
    trpc: { abortOnUnmount: true },
  });
  const denied = resourceAccessLost(query.error);
  const tasks = useMemo(() => {
    if (denied) return [];
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap(page => page.items).filter(task => {
      if (seen.has(task.id)) return false;
      seen.add(task.id); return true;
    }) as BoardTask[];
  }, [query.data, denied]);
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    if (!visible || !enabled || !count || !hasNextPage || isFetching || isError) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void fetchNextPage({ cancelRefetch: false });
    }, { root: viewport.current, rootMargin: "0px 0px 160px 0px" });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [visible, enabled, count, hasNextPage, isFetching, isError, fetchNextPage]);
  const { isOver, setNodeRef } = useDroppable({ id: columnKey, disabled: !droppable });

  return (
    <div
      ref={node => { setNodeRef(node); container.current = node; }}
      data-board-column={columnKey}
      className={cn(
        "flex h-[min(70dvh,48rem)] min-h-80 w-[calc(100vw-2rem)] max-w-72 shrink-0 snap-start flex-col rounded-xl border bg-muted/30 transition-colors sm:w-72",
        isOver && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <div
          className={cn("h-2.5 w-2.5 rounded-full", columnColors[columnKey] ?? "bg-muted-foreground")}
        />
        <h3 className="text-sm font-medium">{label}</h3>
        <span aria-label={`${label}: ${count} matching tasks`} title="Total matching current filters" className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>

      <div ref={viewport} tabIndex={0} role="region" aria-label={`${label} tasks`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-b-xl px-2 pb-2 outline-offset-[-2px]">
      <div className="flex min-h-[60px] flex-col gap-2">
        {(tasks.length === 0 && !query.isPending && !query.isError) || count === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">
            {isOver ? "Drop here" : "No tasks"}
          </p>
        ) : (
          tasks.map((task) => (
            <DraggableTaskCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick(task.id)}
              draggable={droppable}
              reqColor={REQ_COLORS[[...task.requirementId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % REQ_COLORS.length]}
              showReqLabel={showReqLabel}
            />
          ))
        )}
      </div>
      <div ref={sentinel} className="flex min-h-10 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground" aria-live="polite">
        {query.isError ? <button type="button" className="underline underline-offset-4" onClick={() => {
          if (query.isFetchNextPageError) void query.fetchNextPage(); else void query.refetch();
        }}>Could not load tasks. Retry</button>
          : query.isFetching ? "Loading tasks…"
          : count === 0 ? null
          : !query.hasNextPage && query.data ? "All tasks loaded" : visible ? "Scroll for more" : null}
      </div>
      </div>
    </div>
  );
}

function DraggableTaskCard({
  task,
  onClick,
  draggable = true,
  reqColor,
  showReqLabel,
}: {
  task: BoardTask;
  onClick: () => void;
  draggable?: boolean;
  reqColor?: string;
  showReqLabel: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
      data: { task },
      disabled: !draggable || task.status === "cancelled",
    });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const isCancelled = task.status === "cancelled";
  const expectedAtInfo = getExpectedAtInfo(task.expectedAt);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={isDragging ? "opacity-30" : ""}
    >
      <Card
        className={cn("min-w-0 cursor-pointer overflow-hidden transition-shadow hover:shadow-md", isCancelled && "opacity-50")}
        onClick={onClick}
      >
        <CardHeader className="p-3 pb-1">
          {showReqLabel && task.requirementTitle && (
            <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
              <span className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium leading-none",
                reqColor ?? "bg-muted text-muted-foreground",
              )}>
                <ClipboardList className="h-2.5 w-2.5 shrink-0" />
                <span className="min-w-0 max-w-[150px] truncate" title={task.requirementTitle}>{task.requirementTitle}</span>
              </span>
              {task.requirementStatus && (
                <span
                  className="max-w-[92px] truncate rounded-sm border px-1 py-0 text-[10px] leading-4 text-muted-foreground"
                  title={requirementStatusLabels[task.requirementStatus] ?? task.requirementStatus}
                >
                  {requirementStatusLabels[task.requirementStatus] ?? task.requirementStatus}
                </span>
              )}
            </div>
          )}
          <CardTitle className={cn("break-words text-sm font-medium leading-snug", isCancelled && "line-through")}>
            {task.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {task.description && (
            <p className="mb-2 text-xs text-muted-foreground line-clamp-2">
              {task.description}
            </p>
          )}
          <div className="mb-2">
            <RepositoryChips links={task.repositories} emptyLabel="Scope unspecified" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={priorityColors[task.priority] ?? "secondary"}
              className="text-[10px] px-1.5 py-0"
            >
              {task.priority}
            </Badge>
            {task.assignee && (
              <Badge
                variant="outline"
                className="min-w-0 max-w-full px-1.5 py-0 text-[10px]"
                title={task.assignee}
              >
                <User className="mr-0.5 h-2.5 w-2.5 shrink-0" />
                <span className="min-w-0 max-w-[148px] truncate">{task.assignee}</span>
              </Badge>
            )}
            {task.tags?.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="min-w-0 max-w-full px-1.5 py-0 text-[10px]"
                title={tag}
              >
                <span className="min-w-0 max-w-[156px] truncate">{tag}</span>
              </Badge>
            ))}
            {expectedAtInfo && (
              <span className={cn("flex items-center gap-0.5 text-[10px]", expectedAtInfo.className)}>
                <Calendar className="h-2.5 w-2.5" />
                {expectedAtInfo.label}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TaskCardOverlay({ task, reqColorMap }: { task: BoardTask; reqColorMap: Map<string, string> }) {
  return (
    <Card className="w-68 rotate-2 shadow-xl">
      <CardHeader className="p-3 pb-1">
        {task.requirementTitle && (
          <span className={cn(
            "mb-1 inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium leading-none",
            reqColorMap.get(task.requirementId) ?? "bg-muted text-muted-foreground",
          )}>
            <ClipboardList className="h-2.5 w-2.5" />
            <span className="max-w-[180px] truncate">{task.requirementTitle}</span>
          </span>
        )}
        <CardTitle className="text-sm font-medium leading-snug">
          {task.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3">
        <div className="mb-2">
          <RepositoryChips links={task.repositories} emptyLabel="Scope unspecified" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={priorityColors[task.priority] ?? "secondary"}
            className="text-[10px] px-1.5 py-0"
          >
            {task.priority}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
