"use client";

import { useState, useMemo } from "react";
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

interface KanbanColumnDef {
  key: string;
  label: string;
  tasks: BoardTask[];
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

function buildColumns(
  allTasks: BoardTask[],
  groupBy: GroupBy,
  includeTerminalColumns: boolean,
): KanbanColumnDef[] {
  if (groupBy === "status") {
    const statuses: TaskStatus[] = includeTerminalColumns
      ? ["todo", "in_progress", "in_review", "done", "cancelled"]
      : ["todo", "in_progress", "in_review"];
    return statuses.map((s) => ({
      key: s,
      label: statusLabels[s] ?? s,
      tasks: allTasks.filter((t) => t.status === s),
    }));
  }

  if (groupBy === "priority") {
    const priorities = ["urgent", "high", "medium", "low"];
    return priorities.map((p) => ({
      key: p,
      label: priorityLabels[p] ?? p,
      tasks: allTasks.filter((t) => t.priority === p),
    }));
  }

  const assigneeMap = new Map<string, BoardTask[]>();
  for (const task of allTasks) {
    const key = task.assignee ?? "Unassigned";
    const list = assigneeMap.get(key) ?? [];
    list.push(task);
    assigneeMap.set(key, list);
  }
  const keys = [...assigneeMap.keys()].sort((a, b) => {
    if (a === "Unassigned") return -1;
    if (b === "Unassigned") return 1;
    return a.localeCompare(b);
  });
  return keys.map((key) => ({
    key,
    label: key,
    tasks: assigneeMap.get(key) ?? [],
  }));
}

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
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const isMobile = useIsMobile();
  const boardQueryInput = useMemo(() => ({
    projectId,
    page, pageSize: 50, requirementId: scopeReqId === "__all__" ? undefined : scopeReqId,
    includeTerminal: showTerminalColumns,
    completedWithinDays: showTerminalColumns && showAllCompleted ? 0 : undefined,
  }), [projectId, page, scopeReqId, showAllCompleted, showTerminalColumns]);
  const result = trpc.task.boardPage.useQuery(boardQueryInput);
  const board = result.isError ? undefined : result.data;
  const pageCount = Math.max(1, board?.pageCount ?? 1);
  if (board && page > pageCount) setPage(pageCount);
  const utils = trpc.useUtils();

  const handleTaskClick = externalOnTaskClick ?? ((id: string) => setSelectedTaskId(id));
  const managesOwnSheet = !externalOnTaskClick;

  const updateStatus = trpc.task.updateStatus.useMutation({
    onMutate: async ({ id, status: newStatus }) => {
      await utils.task.boardPage.cancel(boardQueryInput);
      const prev = utils.task.boardPage.getData(boardQueryInput);
      if (prev) {
        utils.task.boardPage.setData(boardQueryInput, { ...prev,
          items: prev.items.map(task => task.id === id ? { ...task, status: newStatus } : task),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.task.boardPage.setData(boardQueryInput, ctx.prev);
      toast.error("Failed to update task status");
    },
    onSettled: () => {
      utils.task.board.invalidate({ projectId });
      utils.task.boardPage.invalidate({ projectId });
      utils.requirement.list.invalidate({ projectId });
      utils.requirement.listSummary.invalidate({ projectId });
      utils.task.gantt.invalidate({ projectId });
    },
  });

  const allTasks = useMemo(() => {
    if (!board) return [];
    return board.items as BoardTask[];
  }, [board]);

  const requirements = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of allTasks) {
      if (t.requirementId && !map.has(t.requirementId)) {
        map.set(t.requirementId, t.requirementTitle || t.requirementId.slice(0, 8));
      }
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  }, [allTasks]);

  const reqColorMap = useMemo(() => {
    const m = new Map<string, string>();
    requirements.forEach((r, i) => m.set(r.id, REQ_COLORS[i % REQ_COLORS.length]));
    return m;
  }, [requirements]);

  const filteredTasks = useMemo(() => {
    const scoped = scopeReqId === "__all__"
      ? allTasks
      : allTasks.filter((t) => t.requirementId === scopeReqId);
    if (showTerminalColumns) return scoped;
    return scoped.filter((t) => t.status !== "done" && t.status !== "cancelled");
  }, [allTasks, scopeReqId, showTerminalColumns]);

  const terminalCount = useMemo(() => {
    const scoped = scopeReqId === "__all__"
      ? allTasks
      : allTasks.filter((t) => t.requirementId === scopeReqId);
    return scoped.filter((t) => t.status === "done" || t.status === "cancelled").length;
  }, [allTasks, scopeReqId]);

  const columns = useMemo(
    () => buildColumns(filteredTasks, groupBy, showTerminalColumns),
    [filteredTasks, groupBy, showTerminalColumns],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    if (readOnly) return;
    const task = filteredTasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (readOnly || !over) return;

    const taskId = active.id as string;
    const targetColumn = over.id as string;
    const task = filteredTasks.find((t) => t.id === taskId);

    if (!task || task.status === "cancelled") return;

    if (groupBy === "status" && task.status !== targetColumn) {
      updateStatus.mutate({ id: taskId, status: targetColumn as TaskStatus });
    }
  };

  return (
    <>
      <div className="mb-3 grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Group page by</span>
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
            invalid={false} allowAll includeCancelled onValueChange={id => { setScopeReqId(id); setPage(1); }} />}
        </div>

        <button
          onClick={() => { setShowTerminalColumns(v => !v); setPage(1); }}
          className={cn(
            "flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors sm:min-h-7",
            showTerminalColumns
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={showTerminalColumns ? "Hide done and cancelled tasks" : "Show done and cancelled tasks"}
        >
          {showTerminalColumns ? <CheckCircle2 className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {showTerminalColumns ? `Terminal shown${terminalCount ? ` (${terminalCount})` : ""}` : "Terminal hidden"}
        </button>

        {showTerminalColumns && (
          <button
            onClick={() => { setShowAllCompleted(v => !v); setPage(1); }}
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
          {board ? `${board.total} matching tasks · ${filteredTasks.length} on this page` : "Loading tasks..."}
        </span>
        {isMobile && groupBy === "status" && (
          <span className="col-span-2 text-xs text-muted-foreground">
            Open a task to change its status. Dragging is paused on touch screens.
          </span>
        )}
      </div>

      <nav aria-label="Board task pages" className="mb-3 flex items-center justify-between gap-2 text-sm">
        <Button type="button" variant="outline" size="sm" disabled={page <= 1 || result.isFetching}
          onClick={() => setPage(current => current - 1)}>Previous tasks</Button>
        <span aria-live="polite">{board ? `Page ${page} of ${pageCount}` : result.isError ? `Page ${page} unavailable` : `Loading page ${page}...`}</span>
        <Button type="button" variant="outline" size="sm" disabled={!board || page >= pageCount || result.isFetching}
          onClick={() => setPage(current => current + 1)}>Next tasks</Button>
      </nav>
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
                key={column.key}
                columnKey={column.key}
                label={column.label}
                count={column.tasks.length}
                tasks={column.tasks}
                droppable={groupBy === "status" && !isMobile}
                onTaskClick={handleTaskClick}
                reqColorMap={reqColorMap}
                showReqLabel={scopeReqId === "__all__" && requirements.length > 1}
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

function KanbanColumn({
  columnKey,
  label,
  count,
  tasks,
  droppable,
  onTaskClick,
  reqColorMap,
  showReqLabel,
}: {
  columnKey: string;
  label: string;
  count: number;
  tasks: BoardTask[];
  droppable: boolean;
  onTaskClick: (id: string) => void;
  reqColorMap: Map<string, string>;
  showReqLabel: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: columnKey, disabled: !droppable });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-[calc(100vw-2rem)] max-w-72 shrink-0 snap-start flex-col rounded-xl border bg-muted/30 transition-colors sm:w-72",
        isOver && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <div
          className={cn("h-2.5 w-2.5 rounded-full", columnColors[columnKey] ?? "bg-muted-foreground")}
        />
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{count}</span>
      </div>

      <div className="flex min-h-[60px] flex-col gap-2 px-2 pb-2">
        {tasks.length === 0 ? (
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
              reqColor={reqColorMap.get(task.requirementId)}
              showReqLabel={showReqLabel}
            />
          ))
        )}
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
