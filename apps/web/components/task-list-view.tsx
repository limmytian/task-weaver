"use client";

import { useState } from "react";
import { trpc } from "@/trpc/client";
import type { TaskStatus, TaskPriority } from "@task-weaver/core";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskDetailSheet } from "./task-detail-sheet";
import { RepositoryChips } from "./repository-links";

const statusOptions = [
  { value: "__all__", label: "All Statuses" },
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const priorityOptions = [
  { value: "__all__", label: "All Priorities" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const statusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  todo: "secondary",
  in_progress: "default",
  in_review: "default",
  done: "outline",
  cancelled: "destructive",
};

const priorityColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  low: "outline",
  medium: "secondary",
  high: "default",
  urgent: "destructive",
};

export function TaskListView({ projectId }: { projectId: string }) {
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [priorityFilter, setPriorityFilter] = useState("__all__");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: tasks, isLoading } = trpc.task.list.useQuery({
    projectId,
    status: statusFilter === "__all__" ? undefined : (statusFilter as TaskStatus),
    priority: priorityFilter === "__all__" ? undefined : (priorityFilter as TaskPriority),
  });

  return (
    <>
      <div className="mb-4 grid grid-cols-2 items-center gap-2 sm:flex sm:gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-10 w-full sm:h-9 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-10 w-full sm:h-9 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {priorityOptions.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tasks && (
          <span className="col-span-2 text-sm text-muted-foreground sm:col-auto">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : !tasks || tasks.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No tasks match the current filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="hidden grid-cols-[1fr_100px_80px_120px_100px] gap-2 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Title</span>
            <span>Status</span>
            <span>Priority</span>
            <span>Assignee</span>
            <span>Updated</span>
          </div>
          {tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[1fr_100px_80px_120px_100px] md:gap-2 md:px-4 md:py-2.5"
              onClick={() => setSelectedTaskId(task.id)}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{task.title}</p>
                {task.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {task.description}
                  </p>
                )}
                <div className="mt-1">
                  <RepositoryChips links={task.repositories} emptyLabel="Scope unspecified" />
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 md:hidden">
                <Badge
                  variant={statusColors[task.status] ?? "secondary"}
                  className="w-fit px-1.5 py-0 text-[10px]"
                >
                  {task.status.replace("_", " ")}
                </Badge>
                <Badge
                  variant={priorityColors[task.priority] ?? "secondary"}
                  className="w-fit px-1.5 py-0 text-[10px]"
                >
                  {task.priority}
                </Badge>
              </div>
              <Badge
                variant={statusColors[task.status] ?? "secondary"}
                className="hidden w-fit px-1.5 py-0 text-[10px] md:inline-flex"
              >
                {task.status.replace("_", " ")}
              </Badge>
              <Badge
                variant={priorityColors[task.priority] ?? "secondary"}
                className="hidden w-fit px-1.5 py-0 text-[10px] md:inline-flex"
              >
                {task.priority}
              </Badge>
              <span className="hidden truncate text-xs text-muted-foreground md:block">
                {task.assignee ?? "-"}
              </span>
              <span className="hidden text-xs text-muted-foreground md:block">
                {new Date(task.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}

      <TaskDetailSheet
        taskId={selectedTaskId}
        projectId={projectId}
        open={!!selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
        onTaskSelect={setSelectedTaskId}
      />
    </>
  );
}
