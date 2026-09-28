"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, CheckCircle2, Clock, Inbox, MessageSquareText, Plus, Search } from "lucide-react";
import { trpc } from "@/trpc/client";
import type { TaskPriority, TaskStatus } from "@task-weaver/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskDetailSheet } from "@/components/task-detail-sheet";
import { AssistantDialog } from "@/components/assistant-dialog";
import { QueryStatePanel } from "@/components/query-state-panel";

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

const priorityOptions: TaskPriority[] = ["low", "medium", "high", "urgent"];
const TI_SERVER_AGENT_ID = "task-weaver:ti-agent";
const DEFAULT_TI_MODEL_CHOICE = "__default__";
type PersonalInboxViewMode = "inbox" | "today" | "upcoming" | "completed";

function getInitialView(): PersonalInboxViewMode {
  if (typeof window === "undefined") return "inbox";
  const saved = window.localStorage.getItem("tw-personal-inbox-view");
  if (saved === "inbox" || saved === "today" || saved === "upcoming" || saved === "completed") {
    return saved;
  }
  return "inbox";
}

export function PersonalInboxView() {
  const [view, setView] = useState<PersonalInboxViewMode>(getInitialView);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [expectedDate, setExpectedDate] = useState("");
  const [assignTi, setAssignTi] = useState("false");
  const [tiModelChoice, setTiModelChoice] = useState(DEFAULT_TI_MODEL_CHOICE);
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "__all__">("__all__");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    window.localStorage.setItem("tw-personal-inbox-view", view);
  }, [view]);

  const {
    data: tasks,
    error,
    isError,
    isLoading,
    refetch,
  } = trpc.task.listPersonal.useQuery({
    completedWithinDays: view === "completed" ? 30 : undefined,
  });
  const { data: tiModelConfigs } = trpc.piAgent.listConfigs.useQuery({ includeDisabled: false });

  const createTask = trpc.task.createPersonal.useMutation({
    onSuccess: () => {
      setTitle("");
      setPriority("medium");
      setExpectedDate("");
      setAssignTi("false");
      setTiModelChoice(DEFAULT_TI_MODEL_CHOICE);
      utils.task.listPersonal.invalidate();
    },
    onError: (err) => toast.error("Failed to create task", { description: err.message }),
  });

  const updateStatus = trpc.task.updateStatus.useMutation({
    onSuccess: () => {
      utils.task.listPersonal.invalidate();
    },
    onError: (err) => toast.error("Failed to update task", { description: err.message }),
  });

  const filteredTasks = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const normalizedQuery = query.trim().toLowerCase();

    return (tasks ?? []).filter((task) => {
      const isTerminal = task.status === "done" || task.status === "cancelled";
      if (view === "completed") {
        if (!isTerminal) return false;
      } else if (isTerminal) {
        return false;
      }
      if (view === "today") {
        if (!task.expectedAt) return false;
        const expected = new Date(task.expectedAt);
        if (expected >= tomorrow) return false;
      }
      if (view === "upcoming") {
        if (!task.expectedAt) return false;
        if (new Date(task.expectedAt) < tomorrow) return false;
      }
      if (priorityFilter !== "__all__" && task.priority !== priorityFilter) return false;
      if (normalizedQuery) {
        const searchable = `${task.title} ${task.description ?? ""}`.toLowerCase();
        if (!searchable.includes(normalizedQuery)) return false;
      }
      return true;
    }).sort((a, b) => {
      const aDate = a.expectedAt ? new Date(a.expectedAt).getTime() : Infinity;
      const bDate = b.expectedAt ? new Date(b.expectedAt).getTime() : Infinity;
      if (aDate !== bDate) return aDate - bDate;
      return priorityOptions.indexOf(b.priority) - priorityOptions.indexOf(a.priority);
    });
  }, [priorityFilter, query, tasks, view]);

  const counts = useMemo(() => {
    const openTasks = (tasks ?? []).filter((task) => task.status !== "done" && task.status !== "cancelled");
    const completed = (tasks ?? []).filter((task) => task.status === "done" || task.status === "cancelled");
    const dueToday = openTasks.filter((task) => {
      if (!task.expectedAt) return false;
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return new Date(task.expectedAt) < tomorrow;
    });
    const urgent = openTasks.filter((task) => task.priority === "urgent");
    return {
      open: openTasks.length,
      completed: completed.length,
      dueToday: dueToday.length,
      urgent: urgent.length,
    };
  }, [tasks]);

  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Personal Inbox</h1>
            <p className="text-sm text-muted-foreground">
              Your private tasks outside any project. {counts.open} open, {counts.completed} completed.
            </p>
          </div>
          <form
            className={`grid w-full gap-2 md:max-w-4xl ${assignTi === "true" ? "md:grid-cols-[minmax(0,1fr)_112px_120px_140px_180px_40px]" : "md:grid-cols-[minmax(0,1fr)_112px_120px_140px_40px]"}`}
            onSubmit={(event) => {
              event.preventDefault();
              const nextTitle = title.trim();
              if (!nextTitle) return;
              const selectedTiModel = tiModelConfigs?.find((config) => config.id === tiModelChoice);
              createTask.mutate({
                title: nextTitle,
                priority,
                expectedAt: expectedDate ? new Date(`${expectedDate}T00:00:00`) : undefined,
                assignee: assignTi === "true" ? TI_SERVER_AGENT_ID : undefined,
                assigneeType: assignTi === "true" ? "agent" : undefined,
                requestedPiProvider: assignTi === "true" ? selectedTiModel?.provider : undefined,
                requestedPiModel: assignTi === "true" ? selectedTiModel?.model : undefined,
              });
            }}
          >
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Add a personal task"
              className="h-9"
            />
            <Select value={priority} onValueChange={(value) => setPriority(value as TaskPriority)}>
              <SelectTrigger className="h-10 w-full md:h-9 md:w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {priorityOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={assignTi}
              onValueChange={(value) => {
                setAssignTi(value);
                if (value !== "true") setTiModelChoice(DEFAULT_TI_MODEL_CHOICE);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">Manual</SelectItem>
                <SelectItem value="true">Assign Ti</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={expectedDate}
              onChange={(event) => setExpectedDate(event.target.value)}
              className="h-9"
              aria-label="Expected date"
            />
            {assignTi === "true" && (
              <Select value={tiModelChoice} onValueChange={setTiModelChoice}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TI_MODEL_CHOICE}>Default Ti model</SelectItem>
                  {(tiModelConfigs ?? []).map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      {config.label || `${config.provider}:${config.model}`}
                      {config.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              type="submit"
              size="sm"
              className="w-full md:w-10"
              aria-label="Add personal task"
              disabled={!title.trim() || createTask.isPending}
            >
              <Plus className="h-4 w-4" />
              <span className="md:sr-only">Add task</span>
            </Button>
          </form>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          <Metric label="Open" value={counts.open} />
          <Metric label="Due now" value={counts.dueToday} muted={counts.dueToday > 0} />
          <Metric label="Urgent" value={counts.urgent} muted={counts.urgent > 0} />
          <Metric label="Completed" value={counts.completed} />
        </div>

        <Tabs value={view} onValueChange={(value) => setView(value as typeof view)}>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <TabsList className="scrollbar-none max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="inbox">
                <Inbox className="mr-1.5 h-3.5 w-3.5" />
                Inbox
              </TabsTrigger>
              <TabsTrigger value="today">
                <Clock className="mr-1.5 h-3.5 w-3.5" />
                Today
              </TabsTrigger>
              <TabsTrigger value="upcoming">
                <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
                Upcoming
              </TabsTrigger>
              <TabsTrigger value="completed">
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Completed
              </TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <MessageSquareText className="h-3.5 w-3.5" />
              <span>Use Chat for planning, cleanup, or turning notes into tasks.</span>
              <AssistantDialog contextKind="global" label="Chat" />
            </div>
          </div>
        </Tabs>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_160px]">
          <div className="relative min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search personal tasks"
              className="h-9 pl-9"
            />
          </div>
          <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as TaskPriority | "__all__")}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All priorities</SelectItem>
              {priorityOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isError ? (
          <QueryStatePanel
            icon={<Inbox className="h-5 w-5" />}
            title="Personal tasks could not be loaded"
            description={error.message}
            onAction={() => refetch()}
          />
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="grid grid-cols-[32px_1fr_auto] items-center gap-3 rounded-md border px-3 py-2.5">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : filteredTasks.length === 0 ? (
          <QueryStatePanel
            icon={<Inbox className="h-5 w-5" />}
            title="No personal tasks in this view"
            description={query || priorityFilter !== "__all__" ? "Adjust the search or priority filter." : emptyDescription(view)}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                className="grid cursor-pointer grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-3 text-sm transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[36px_1fr_96px_90px_70px_120px] md:gap-3 md:py-2.5"
                onClick={() => setSelectedTaskId(task.id)}
              >
                <button
                  type="button"
                  aria-label="Mark done"
                  className="flex size-10 items-center justify-center rounded-full border text-muted-foreground hover:border-primary hover:text-primary md:size-7"
                  onClick={(event) => {
                    event.stopPropagation();
                    updateStatus.mutate({
                      id: task.id,
                      status: (task.status === "done" ? "todo" : "done") as TaskStatus,
                      reason: task.status === "done" ? "Reopened from personal inbox" : "Completed from personal inbox",
                    });
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p className="truncate font-medium">{task.title}</p>
                  {task.description && (
                    <p className="truncate text-xs text-muted-foreground">{task.description}</p>
                  )}
                  <p className={`mt-1 text-[11px] md:hidden ${isPastDue(task.expectedAt) ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                    {task.expectedAt ? new Date(task.expectedAt).toLocaleDateString() : "No due date"}
                  </p>
                </div>
                <Badge variant={statusColors[task.status] ?? "secondary"} className="hidden w-fit md:inline-flex">
                  {task.status.replace("_", " ")}
                </Badge>
                <Badge variant={priorityColors[task.priority] ?? "secondary"} className="w-fit">
                  {task.priority}
                </Badge>
                {task.assignee === TI_SERVER_AGENT_ID && (
                  <Badge variant="outline" className="hidden w-fit md:inline-flex">
                    Ti
                  </Badge>
                )}
                <span className={`hidden text-xs md:block ${isPastDue(task.expectedAt) ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                  {task.expectedAt ? new Date(task.expectedAt).toLocaleDateString() : "No date"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <TaskDetailSheet
        taskId={selectedTaskId}
        open={!!selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
        onTaskSelect={setSelectedTaskId}
      />
    </>
  );
}

function Metric({
  label,
  value,
  muted,
}: {
  label: string;
  value: number | string;
  muted?: boolean;
}) {
  return (
    <div className={`rounded-lg border bg-card px-4 py-3 ${muted ? "border-primary/40" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function isPastDue(value: Date | string | null | undefined) {
  if (!value) return false;
  const due = new Date(value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function emptyDescription(view: "inbox" | "today" | "upcoming" | "completed") {
  if (view === "today") return "Tasks with an expected date through today will appear here.";
  if (view === "upcoming") return "Future-dated tasks will appear here.";
  if (view === "completed") return "Recently completed or cancelled tasks will appear here.";
  return "Capture a task above or switch views to review scheduled work.";
}
