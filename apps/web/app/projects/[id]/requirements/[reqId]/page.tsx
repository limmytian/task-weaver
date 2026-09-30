"use client";

import { use, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import type { ExecutionSliceStatus, ModelTier } from "@task-weaver/contracts";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Pencil,
  Save,
  X,
  FileText,
  CheckSquare,
  Trash2,
  Plus,
  GitBranch,
  Layers,
  ListChecks,
  GripVertical,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { BurndownChart } from "@/components/burndown-chart";
import { DependencyDag } from "@/components/dependency-dag";
import { GanttChart } from "@/components/gantt-chart";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { ProjectWorkspaceLinks, WorkspaceBreadcrumbs } from "@/components/project-navigation";
import { TaskDetailSheet } from "@/components/task-detail-sheet";
import { RepositoryChips, RequirementRepositories } from "@/components/repository-links";
import { cn } from "@/lib/utils";

const statusOptions = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "ready_to_merge", label: "Ready to Merge" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];

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

const priorityOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const statusColors: Record<string, string> = {
  draft: "bg-muted-foreground/20",
  approved: "bg-blue-500",
  in_progress: "bg-amber-500",
  in_review: "bg-purple-500",
  ready_to_merge: "bg-cyan-500",
  done: "bg-green-500",
  cancelled: "bg-destructive",
  archived: "bg-muted-foreground/50",
};

const taskStatusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

const taskStatusBadgeClasses: Record<string, string> = {
  todo: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
  in_progress: "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  in_review: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  done: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
};

const sliceStatusOptions: Array<{ value: ExecutionSliceStatus; label: string }> = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const sliceStatusBadgeClasses: Record<string, string> = {
  todo: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
  in_progress: "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  in_review: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  done: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
};

const modelTierOptions: Array<{ value: ModelTier; label: string }> = [
  { value: "fast", label: "Fast" },
  { value: "standard", label: "Standard" },
  { value: "strong", label: "Strong" },
];

const modelTierLabels: Record<string, string> = {
  fast: "Fast",
  standard: "Standard",
  strong: "Strong",
};

type RequirementTaskSummary = {
  id: string;
  title: string;
  status: string;
  executionSliceId?: string | null;
  repositories?: Array<{
    repository: {
      id: string;
      displayName: string;
      canonicalKey: string;
      provider: string;
    };
  }>;
};

const UNASSIGNED_SLICE_DROP_ID = "__unassigned_slice_tasks__";

function sliceDropId(sliceId: string) {
  return `slice:${sliceId}`;
}

function parseSliceDropId(dropId: string) {
  if (dropId === UNASSIGNED_SLICE_DROP_ID) return null;
  return dropId.startsWith("slice:") ? dropId.slice("slice:".length) : undefined;
}

export default function RequirementDetailPage({
  params,
}: {
  params: Promise<{ id: string; reqId: string }>;
}) {
  const { id: projectId, reqId } = use(params);
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardEditConfirmOpen, setDiscardEditConfirmOpen] = useState(false);
  const [editSubmitAttempted, setEditSubmitAttempted] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data: requirement, isLoading } = trpc.requirement.get.useQuery(
    { id: reqId },
  );
  const { data: project } = trpc.project.get.useQuery({ id: projectId });

  useEffect(() => {
    if (requirement && !editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(requirement.title);
      setDescription(requirement.description ?? "");
    }
  }, [requirement, editing]);

  const updateReq = trpc.requirement.update.useMutation({
    onSuccess: () => {
      utils.requirement.get.invalidate({ id: reqId });
      utils.requirement.list.invalidate({ projectId });
      setEditSubmitAttempted(false);
      setEditing(false);
      toast.success("Requirement updated");
    },
    onError: (err) => toast.error("Failed to update requirement", { description: err.message }),
  });

  const deleteReq = trpc.requirement.delete.useMutation({
    onSuccess: () => {
      utils.requirement.list.invalidate({ projectId });
      router.push(`/projects/${projectId}`);
      toast.success("Requirement cancelled");
    },
    onError: (err) => toast.error("Failed to cancel requirement", { description: err.message }),
  });

  const unlinkDoc = trpc.requirement.unlinkDocument.useMutation({
    onSuccess: () => {
      utils.requirement.get.invalidate({ id: reqId });
    },
  });

  const handleStartEdit = () => {
    if (requirement) {
      setTitle(requirement.title);
      setDescription(requirement.description ?? "");
    }
    setEditSubmitAttempted(false);
    setEditing(true);
  };

  const resetEditForm = () => {
    if (requirement) {
      setTitle(requirement.title);
      setDescription(requirement.description ?? "");
    }
    setEditSubmitAttempted(false);
  };

  const editIsDirty = Boolean(
    requirement &&
      (title !== requirement.title || description !== (requirement.description ?? "")),
  );
  const editTitleError =
    editSubmitAttempted && !title.trim() ? "Requirement title is required." : null;

  const handleCancelEdit = () => {
    if (editIsDirty) {
      setDiscardEditConfirmOpen(true);
      return;
    }
    resetEditForm();
    setEditing(false);
  };

  const handleSave = () => {
    setEditSubmitAttempted(true);
    if (!title.trim()) return;
    if (!editIsDirty) {
      setEditing(false);
      return;
    }
    updateReq.mutate({
      id: reqId,
      data: { title: title.trim(), description: description.trim() },
    });
  };

  if (isLoading) {
    return (
      <>
        <header className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="mt-3 space-y-2">
            <Skeleton className="h-6 w-96 max-w-full" />
            <Skeleton className="h-4 w-52" />
          </div>
        </header>
        <div className="p-4 md:p-6">
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </>
    );
  }

  if (!requirement) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-muted-foreground">Requirement not found</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push(`/projects/${projectId}`)}
        >
          Back to Project
        </Button>
      </div>
    );
  }

  const isCancelled = requirement.status === "cancelled";

  return (
    <>
      <header className="border-b px-4 py-3">
        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to project workspace">
            <Link href={`/projects/${projectId}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <WorkspaceBreadcrumbs
            items={[
              { label: "Projects", href: "/projects" },
              {
                label: project?.name ?? "Project",
                href: `/projects/${projectId}`,
              },
              { label: editing ? "Editing Requirement" : requirement.title },
            ]}
            className="min-w-0 flex-1"
          />
          <div className="col-span-3 mt-1 flex w-full items-center gap-2 sm:col-auto sm:mt-0 sm:ml-auto sm:w-auto">
            {editing ? (
              <>
                <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={handleCancelEdit}>
                  <X className="mr-1 h-4 w-4" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={handleSave}
                  disabled={!title.trim() || !editIsDirty || updateReq.isPending}
                >
                  <Save className="mr-1 h-4 w-4" />
                  {updateReq.isPending ? "Saving..." : "Save"}
                </Button>
              </>
            ) : (
              !isCancelled && (
                <>
                  <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={handleStartEdit} disabled={updateReq.isPending}>
                    <Pencil className="mr-1 h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="flex-1 sm:flex-none"
                    onClick={() => setDeleteConfirmOpen(true)}
                    disabled={deleteReq.isPending}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {deleteReq.isPending ? "Cancelling..." : "Cancel"}
                  </Button>
                </>
              )
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
              {editing ? "Editing Requirement" : requirement.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {requirementStatusLabels[requirement.status] ?? requirement.status}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {requirement.priority}
              </Badge>
              {requirement.expectedAt && (
                <span className="text-xs text-muted-foreground">
                  Due {new Date(requirement.expectedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <ProjectWorkspaceLinks projectId={projectId} active="workspace" className="w-full sm:w-auto" />
        </div>
      </header>

      <div className="grid gap-4 p-3 sm:p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {editing ? (
            <div className="space-y-4">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-lg font-semibold"
                placeholder="Requirement title"
                aria-invalid={Boolean(editTitleError)}
              />
              {editTitleError && (
                <p className="-mt-2 text-xs text-destructive">{editTitleError}</p>
              )}
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={12}
                className="text-sm"
                placeholder="Describe the requirement..."
              />
            </div>
          ) : (
            <>
              {/* Status & Priority controls */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Status
                  </label>
                  <Select
                    value={requirement.status}
                    onValueChange={(value) =>
                      updateReq.mutate({
                        id: reqId,
                        data: { status: value as typeof requirement.status },
                      })
                    }
                    disabled={isCancelled || updateReq.isPending}
                  >
                    <SelectTrigger className="h-9">
                      <div className="flex items-center gap-2">
                        <div
                          className={`h-2 w-2 rounded-full ${statusColors[requirement.status] ?? ""}`}
                        />
                        <SelectValue />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Priority
                  </label>
                  <Select
                    value={requirement.priority}
                    onValueChange={(value) =>
                      updateReq.mutate({
                        id: reqId,
                        data: { priority: value as typeof requirement.priority },
                      })
                    }
                    disabled={isCancelled || updateReq.isPending}
                  >
                    <SelectTrigger className="h-9">
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
                </div>
              </div>

              {/* Expected Deadline */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Expected Deadline
                </label>
                <Input
                  type="date"
                  value={requirement.expectedAt ? new Date(requirement.expectedAt).toISOString().slice(0, 10) : ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateReq.mutate({
                      id: reqId,
                      data: { expectedAt: val ? new Date(val + "T00:00:00") : null },
                    });
                  }}
                  disabled={isCancelled || updateReq.isPending}
                  className="h-10 w-full sm:h-9 sm:w-48"
                />
              </div>

              {/* Tags */}
              {requirement.tags && requirement.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {requirement.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Description */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Description
                </label>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {requirement.description || "No description"}
                </p>
              </div>

              {/* Meta */}
              <div className="text-xs text-muted-foreground">
                Created by {requirement.createdBy} on{" "}
                {new Date(requirement.createdAt).toLocaleString()}
              </div>

              {/* Burndown Chart */}
              <BurndownChart requirementId={reqId} />

              <ExecutionSlicesPanel
                requirementId={reqId}
                projectId={projectId}
                tasks={requirement.tasks ?? []}
                isCancelled={isCancelled}
                onTaskClick={setSelectedTaskId}
              />

              <GanttChart
                projectId={projectId}
                requirementId={reqId}
                title="Requirement Timeline"
              />

              <TaskDependencyDag
                requirementId={reqId}
                onTaskClick={setSelectedTaskId}
              />

              <KnowledgeGraph
                projectId={projectId}
                title="Requirement Graph"
                focusNodeId={reqId}
                focusDepth={2}
                onTaskClick={setSelectedTaskId}
              />
            </>
          )}
        </div>

        {/* Sidebar */}
        <RequirementSidebar
          requirement={requirement}
          projectId={projectId}
          isCancelled={isCancelled}
          unlinkDoc={unlinkDoc}
          onTaskClick={setSelectedTaskId}
        />
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Cancel Requirement"
        description={`Are you sure you want to cancel "${requirement.title}"? This will set the requirement status to cancelled.`}
        confirmLabel="Cancel Requirement"
        destructive
        onConfirm={() => deleteReq.mutate({ id: reqId })}
      />
      <ConfirmDialog
        open={discardEditConfirmOpen}
        onOpenChange={setDiscardEditConfirmOpen}
        title="Discard requirement edits?"
        description="The requirement has unsaved title or description changes."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          resetEditForm();
          setDiscardEditConfirmOpen(false);
          setEditing(false);
        }}
      />
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

function ExecutionSlicesPanel({
  requirementId,
  projectId,
  tasks,
  isCancelled,
  onTaskClick,
}: {
  requirementId: string;
  projectId: string;
  tasks: RequirementTaskSummary[];
  isCancelled: boolean;
  onTaskClick: (taskId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createModelTier, setCreateModelTier] = useState<ModelTier>("standard");
  const [createAllowParallel, setCreateAllowParallel] = useState(false);
  const [activeSliceTask, setActiveSliceTask] = useState<RequirementTaskSummary | null>(null);
  const utils = trpc.useUtils();

  const { data: slices, isLoading } = trpc.requirement.listSlices.useQuery({ requirementId });
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const invalidateSliceData = () => {
    utils.requirement.listSlices.invalidate({ requirementId });
    utils.requirement.get.invalidate({ id: requirementId });
    utils.task.gantt.invalidate({ projectId });
    utils.task.board.invalidate({ projectId });
  };

  const createSlice = trpc.requirement.createSlice.useMutation({
    onSuccess: () => {
      setCreateTitle("");
      setCreateDescription("");
      setCreateModelTier("standard");
      setCreateAllowParallel(false);
      setCreating(false);
      invalidateSliceData();
      toast.success("Execution slice created");
    },
    onError: (err) => toast.error("Failed to create execution slice", { description: err.message }),
  });

  const updateSlice = trpc.requirement.updateSlice.useMutation({
    onSuccess: invalidateSliceData,
    onError: (err) => toast.error("Failed to update execution slice", { description: err.message }),
  });

  const deleteSlice = trpc.requirement.deleteSlice.useMutation({
    onSuccess: () => {
      invalidateSliceData();
      toast.success("Execution slice deleted");
    },
    onError: (err) => toast.error("Failed to delete execution slice", { description: err.message }),
  });

  const moveTaskToSlice = trpc.task.update.useMutation({
    onSuccess: invalidateSliceData,
    onError: (err) => toast.error("Failed to move task", { description: err.message }),
  });

  const assignedTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const slice of slices ?? []) {
      for (const task of slice.tasks ?? []) {
        ids.add(task.id);
      }
    }
    return ids;
  }, [slices]);

  const taskSliceById = useMemo(() => {
    const assignments = new Map<string, { id: string; title: string }>();
    for (const slice of slices ?? []) {
      for (const task of slice.tasks ?? []) {
        assignments.set(task.id, { id: slice.id, title: slice.title });
      }
    }
    return assignments;
  }, [slices]);

  const taskById = useMemo(() => {
    return new Map(tasks.map((task) => [task.id, task]));
  }, [tasks]);

  const tasksBySliceId = useMemo(() => {
    const grouped = new Map<string, RequirementTaskSummary[]>();
    for (const slice of slices ?? []) {
      grouped.set(slice.id, (slice.tasks ?? []).map((task) => {
        return taskById.get(task.id) ?? {
          id: task.id,
          title: task.title,
          status: task.status,
          executionSliceId: slice.id,
        };
      }));
    }
    return grouped;
  }, [slices, taskById]);

  const unassignedTasks = useMemo(() => {
    return tasks.filter((task) => !assignedTaskIds.has(task.id));
  }, [assignedTaskIds, tasks]);

  const visibleSliceTasks = useMemo(() => {
    return [...unassignedTasks, ...Array.from(tasksBySliceId.values()).flat()];
  }, [tasksBySliceId, unassignedTasks]);

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = createTitle.trim();
    if (!nextTitle) return;
    createSlice.mutate({
      requirementId,
      title: nextTitle,
      description: createDescription.trim() || undefined,
      modelTier: createModelTier,
      allowParallel: createAllowParallel,
    });
  };

  const handleSliceTaskDragStart = (event: DragStartEvent) => {
    const task = visibleSliceTasks.find((item) => item.id === String(event.active.id));
    setActiveSliceTask(task ?? null);
  };

  const handleSliceTaskDragEnd = (event: DragEndEvent) => {
    setActiveSliceTask(null);
    const targetSliceId = event.over ? parseSliceDropId(String(event.over.id)) : undefined;
    if (targetSliceId === undefined) return;

    const taskId = String(event.active.id);
    const currentSliceId = taskSliceById.get(taskId)?.id ?? null;
    if (currentSliceId === targetSliceId) return;

    moveTaskToSlice.mutate({
      id: taskId,
      data: { executionSliceId: targetSliceId },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4" />
            Execution Slices
          </h2>
          <p className="text-xs text-muted-foreground">
            {(slices ?? []).length} slice{(slices ?? []).length !== 1 ? "s" : ""}, {assignedTaskIds.size}/{tasks.length} tasks assigned.
          </p>
        </div>
        {!isCancelled && (
          <Button
            type="button"
            size="sm"
            variant={creating ? "outline" : "default"}
            onClick={() => setCreating((value) => !value)}
          >
            {creating ? <X className="mr-1 h-4 w-4" /> : <Plus className="mr-1 h-4 w-4" />}
            {creating ? "Close" : "Add Slice"}
          </Button>
        )}
      </div>

      {creating && (
        <form className="space-y-3 rounded-lg border bg-muted/20 p-3" onSubmit={handleCreateSubmit}>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
            <Input
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              placeholder="Slice title"
              className="h-9"
            />
            <Select value={createModelTier} onValueChange={(value) => setCreateModelTier(value as ModelTier)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelTierOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={createDescription}
            onChange={(event) => setCreateDescription(event.target.value)}
            rows={2}
            placeholder="Optional execution notes"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={createAllowParallel}
              onChange={(event) => setCreateAllowParallel(event.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            Allow this slice to run before earlier slices are terminal
          </label>
          <div className="flex justify-end gap-2">
            <Button type="submit" size="sm" disabled={!createTitle.trim() || createSlice.isPending}>
              {createSlice.isPending ? "Creating..." : "Create Slice"}
            </Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : !slices || slices.length === 0 ? (
        <div className="rounded-lg border border-dashed py-8 text-center">
          <ListChecks className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No execution slices</p>
          <p className="text-xs text-muted-foreground">
            Split this requirement into independently executable slices.
          </p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleSliceTaskDragStart}
          onDragEnd={handleSliceTaskDragEnd}
        >
          <div className="grid gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
            <SliceTaskDropZone
              dropId={UNASSIGNED_SLICE_DROP_ID}
              title="Unassigned Tasks"
              tasks={unassignedTasks}
              disabled={isCancelled || moveTaskToSlice.isPending}
              emptyLabel={tasks.length === 0 ? "No tasks in this requirement." : "No unassigned tasks."}
              onTaskClick={onTaskClick}
            />

            <div className="space-y-3">
              {slices.map((slice) => {
                const sliceTasks = tasksBySliceId.get(slice.id) ?? [];
                const blockedByEarlierSlice = !slice.allowParallel && slices.some((candidate) =>
                  candidate.orderIndex < slice.orderIndex
                  && candidate.status !== "done"
                  && candidate.status !== "cancelled",
                );

                return (
                  <div key={slice.id} className="space-y-3 rounded-lg border p-3">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
                      <div className="space-y-2">
                        <div className="grid gap-2 md:grid-cols-[72px_minmax(0,1fr)]">
                          <Input
                            type="number"
                            min={0}
                            defaultValue={slice.orderIndex}
                            className="h-9"
                            aria-label="Slice order"
                            disabled={isCancelled || updateSlice.isPending}
                            onBlur={(event) => {
                              const nextOrder = Number(event.target.value);
                              if (Number.isInteger(nextOrder) && nextOrder >= 0 && nextOrder !== slice.orderIndex) {
                                updateSlice.mutate({ id: slice.id, data: { orderIndex: nextOrder } });
                              }
                            }}
                          />
                          <Input
                            defaultValue={slice.title}
                            className="h-9 font-medium"
                            aria-label="Slice title"
                            disabled={isCancelled || updateSlice.isPending}
                            onBlur={(event) => {
                              const nextTitle = event.target.value.trim();
                              if (nextTitle && nextTitle !== slice.title) {
                                updateSlice.mutate({ id: slice.id, data: { title: nextTitle } });
                              }
                            }}
                          />
                        </div>
                        <Textarea
                          defaultValue={slice.description ?? ""}
                          rows={2}
                          aria-label="Slice description"
                          placeholder="No description"
                          disabled={isCancelled || updateSlice.isPending}
                          onBlur={(event) => {
                            const nextDescription = event.target.value.trim() || null;
                            if (nextDescription !== (slice.description ?? null)) {
                              updateSlice.mutate({ id: slice.id, data: { description: nextDescription } });
                            }
                          }}
                        />
                        <Textarea
                          defaultValue={slice.resultSummary ?? ""}
                          rows={2}
                          aria-label="Slice result summary"
                          placeholder="Result summary"
                          disabled={isCancelled || updateSlice.isPending}
                          onBlur={(event) => {
                            const nextSummary = event.target.value.trim() || null;
                            if (nextSummary !== (slice.resultSummary ?? null)) {
                              updateSlice.mutate({ id: slice.id, data: { resultSummary: nextSummary } });
                            }
                          }}
                        />
                      </div>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            value={slice.status}
                            onValueChange={(value) =>
                              updateSlice.mutate({
                                id: slice.id,
                                data: { status: value as ExecutionSliceStatus },
                              })
                            }
                            disabled={isCancelled || updateSlice.isPending}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {sliceStatusOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                  disabled={blockedByEarlierSlice && ["in_progress", "in_review", "done"].includes(option.value)}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={slice.modelTier}
                            onValueChange={(value) =>
                              updateSlice.mutate({
                                id: slice.id,
                                data: { modelTier: value as ModelTier },
                              })
                            }
                            disabled={isCancelled || updateSlice.isPending}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {modelTierOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={slice.allowParallel}
                            onChange={(event) => updateSlice.mutate({
                              id: slice.id,
                              data: { allowParallel: event.target.checked },
                            })}
                            disabled={isCancelled || updateSlice.isPending}
                            className="h-4 w-4 rounded border-input"
                          />
                          Allow parallel execution
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${sliceStatusBadgeClasses[slice.status] ?? "text-muted-foreground"}`}
                          >
                            {taskStatusLabels[slice.status] ?? slice.status}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            {modelTierLabels[slice.modelTier] ?? slice.modelTier}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {sliceTasks.length} task{sliceTasks.length !== 1 ? "s" : ""}
                          </Badge>
                          {blockedByEarlierSlice && (
                            <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-300">
                              Waiting for earlier slice
                            </Badge>
                          )}
                          {!isCancelled && (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              className="ml-auto text-muted-foreground hover:text-destructive"
                              title="Delete slice"
                              onClick={() => deleteSlice.mutate({ id: slice.id })}
                              disabled={deleteSlice.isPending}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                        <SliceTaskDropZone
                          dropId={sliceDropId(slice.id)}
                          title="Slice Tasks"
                          tasks={sliceTasks}
                          disabled={isCancelled || moveTaskToSlice.isPending}
                          emptyLabel="No tasks."
                          onTaskClick={onTaskClick}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <DragOverlay>
            {activeSliceTask ? (
              <SliceTaskCardOverlay task={activeSliceTask} />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function SliceTaskDropZone({
  dropId,
  title,
  tasks,
  disabled,
  emptyLabel,
  onTaskClick,
}: {
  dropId: string;
  title: string;
  tasks: RequirementTaskSummary[];
  disabled: boolean;
  emptyLabel: string;
  onTaskClick: (taskId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: dropId, disabled });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-lg border bg-background transition-colors",
        isOver && "border-primary/60 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <h3 className="text-xs font-medium">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="flex min-h-24 flex-col gap-2 p-2">
        {tasks.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {isOver ? "Drop here" : emptyLabel}
          </p>
        ) : (
          tasks.map((task) => (
            <SliceTaskCard
              key={task.id}
              task={task}
              disabled={disabled}
              onTaskClick={() => onTaskClick(task.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SliceTaskCard({
  task,
  disabled,
  onTaskClick,
}: {
  task: RequirementTaskSummary;
  disabled: boolean;
  onTaskClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled,
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "opacity-30")}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md border bg-card px-2 py-2 shadow-sm",
          !disabled && "cursor-grab active:cursor-grabbing",
        )}
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full truncate text-left text-xs font-medium hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onTaskClick();
            }}
          >
            {task.title}
          </button>
          <RepositoryChips links={task.repositories} emptyLabel="Scope unspecified" limit={1} />
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 text-[10px] ${taskStatusBadgeClasses[task.status] ?? "text-muted-foreground"}`}
        >
          {taskStatusLabels[task.status] ?? task.status}
        </Badge>
      </div>
    </div>
  );
}

function SliceTaskCardOverlay({ task }: { task: RequirementTaskSummary }) {
  return (
    <div className="flex w-72 min-w-0 rotate-1 items-center gap-2 rounded-md border bg-card px-2 py-2 shadow-lg">
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
      <Badge
        variant="outline"
        className={`shrink-0 text-[10px] ${taskStatusBadgeClasses[task.status] ?? "text-muted-foreground"}`}
      >
        {taskStatusLabels[task.status] ?? task.status}
      </Badge>
    </div>
  );
}

function TaskDependencyDag({
  requirementId,
  onTaskClick,
}: {
  requirementId: string;
  onTaskClick: (taskId: string) => void;
}) {
  const { data, isLoading } = trpc.task.dependencyGraph.useQuery({ requirementId });

  const nodes = data?.nodes.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    external: task.external,
    meta: task.external ? "Dependency from another requirement" : null,
  }));
  const edges = data?.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
  }));

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Task DAG</h2>
        <p className="text-xs text-muted-foreground">
          Arrows point from prerequisite tasks to the tasks they unblock.
        </p>
      </div>
      <DependencyDag
        nodes={nodes}
        edges={edges}
        isLoading={isLoading}
        emptyLabel="No tasks yet."
        onNodeClick={(node) => onTaskClick(node.id)}
      />
    </div>
  );
}

function RequirementSidebar({
  requirement,
  projectId,
  isCancelled,
  unlinkDoc,
  onTaskClick,
}: {
  requirement: {
    id: string;
    tasks?: Array<{ id: string; title: string; status: string }>;
    dependencies?: Array<{
      id: string;
      dependsOnRequirementId: string;
      type: "blocks" | "related";
      dependsOn?: { id: string; title: string; status: string } | null;
    }>;
    dependents?: Array<{
      id: string;
      requirementId: string;
      type: "blocks" | "related";
      requirement?: { id: string; title: string; status: string } | null;
    }>;
    documentLinks?: Array<{
      id: string;
      document: { id: string; title: string };
    }>;
  };
  projectId: string;
  isCancelled: boolean;
  unlinkDoc: { mutate: (input: { linkId: string }) => void };
  onTaskClick: (taskId: string) => void;
}) {
  const [linkingDoc, setLinkingDoc] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState("");
  const [addingDependency, setAddingDependency] = useState(false);
  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [dependencyType, setDependencyType] = useState<"blocks" | "related">("blocks");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: documents } = trpc.document.list.useQuery(
    { projectId },
    { enabled: linkingDoc },
  );
  const { data: requirements } = trpc.requirement.list.useQuery(
    { projectId, completedWithinDays: 0 },
    { enabled: addingDependency },
  );

  const linkDoc = trpc.requirement.linkDocument.useMutation({
    onSuccess: () => {
      utils.requirement.get.invalidate({ id: requirement.id });
      setLinkingDoc(false);
      setSelectedDocId("");
    },
  });

  const existingDocIds = new Set(
    requirement.documentLinks?.map((l) => l.document.id) ?? [],
  );
  const availableDocs = documents?.filter((d) => !existingDocIds.has(d.id));
  const existingDependencyIds = new Set(
    requirement.dependencies?.map((dep) => dep.dependsOnRequirementId) ?? [],
  );
  const availableRequirements = requirements?.filter(
    (req) => req.id !== requirement.id && !existingDependencyIds.has(req.id),
  );

  const addDependency = trpc.requirement.addDependency.useMutation({
    onSuccess: () => {
      utils.requirement.get.invalidate({ id: requirement.id });
      utils.requirement.list.invalidate({ projectId });
      setAddingDependency(false);
      setSelectedRequirementId("");
      setDependencyType("blocks");
    },
    onError: (err) => toast.error("Failed to add dependency", { description: err.message }),
  });

  const removeDependency = trpc.requirement.removeDependency.useMutation({
    onSuccess: () => {
      utils.requirement.get.invalidate({ id: requirement.id });
      utils.requirement.list.invalidate({ projectId });
    },
    onError: (err) => toast.error("Failed to remove dependency", { description: err.message }),
  });

  return (
    <aside className="space-y-4">
      <RequirementRepositories requirementId={requirement.id} disabled={isCancelled} />

      {/* Linked Documents */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Documents ({requirement.documentLinks?.length ?? 0})
            </span>
            {!isCancelled && (
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setLinkingDoc(!linkingDoc)}
              >
                {linkingDoc ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {linkingDoc && (
            <div className="space-y-2 rounded border p-2">
              <Select value={selectedDocId} onValueChange={setSelectedDocId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select document..." />
                </SelectTrigger>
                <SelectContent>
                  {availableDocs?.map((d) => (
                    <SelectItem key={d.id} value={d.id} className="text-xs">
                      {d.title}
                    </SelectItem>
                  ))}
                  {(!availableDocs || availableDocs.length === 0) && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      No documents available
                    </div>
                  )}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-7 w-full text-xs"
                disabled={!selectedDocId || linkDoc.isPending}
                onClick={() =>
                  linkDoc.mutate({
                    requirementId: requirement.id,
                    documentId: selectedDocId,
                  })
                }
              >
                {linkDoc.isPending ? "Linking..." : "Link Document"}
              </Button>
            </div>
          )}
          {requirement.documentLinks?.map((link) => (
            <div
              key={link.id}
              className="flex items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted"
            >
              <Link
                href={`/projects/documents/${link.document.id}`}
                className="flex flex-1 items-center gap-1 min-w-0"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{link.document.title}</span>
              </Link>
              {!isCancelled && (
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => unlinkDoc.mutate({ linkId: link.id })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Requirement Dependencies */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              Dependencies ({requirement.dependencies?.length ?? 0})
            </span>
            {!isCancelled && (
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setAddingDependency(!addingDependency)}
              >
                {addingDependency ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {addingDependency && (
            <div className="space-y-2 rounded border p-2">
              <Select value={selectedRequirementId} onValueChange={setSelectedRequirementId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select requirement..." />
                </SelectTrigger>
                <SelectContent>
                  {availableRequirements?.map((req) => (
                    <SelectItem key={req.id} value={req.id} className="text-xs">
                      {req.title}
                    </SelectItem>
                  ))}
                  {(!availableRequirements || availableRequirements.length === 0) && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      No requirements available
                    </div>
                  )}
                </SelectContent>
              </Select>
              <Select value={dependencyType} onValueChange={(value) => setDependencyType(value as "blocks" | "related")}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blocks" className="text-xs">Blocks</SelectItem>
                  <SelectItem value="related" className="text-xs">Related</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-7 w-full text-xs"
                disabled={!selectedRequirementId || addDependency.isPending}
                onClick={() =>
                  addDependency.mutate({
                    requirementId: requirement.id,
                    dependsOnRequirementId: selectedRequirementId,
                    type: dependencyType,
                  })
                }
              >
                {addDependency.isPending ? "Adding..." : "Add Dependency"}
              </Button>
            </div>
          )}

          {requirement.dependencies && requirement.dependencies.length > 0 ? (
            requirement.dependencies.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted"
              >
                <Link
                  href={`/projects/${projectId}/requirements/${dep.dependsOnRequirementId}`}
                  className="min-w-0 flex-1"
                >
                  <p className="truncate font-medium">
                    {dep.dependsOn?.title ?? dep.dependsOnRequirementId}
                  </p>
                  <div className="mt-1 flex gap-1">
                    <Badge variant="outline" className="text-[10px]">{dep.type}</Badge>
                    {dep.dependsOn?.status && (
                      <Badge variant="secondary" className="text-[10px]">
                        {requirementStatusLabels[dep.dependsOn.status] ?? dep.dependsOn.status}
                      </Badge>
                    )}
                  </div>
                </Link>
                {!isCancelled && (
                  <button
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeDependency.mutate({ depId: dep.id })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">
              No blockers
            </p>
          )}

          {requirement.dependents && requirement.dependents.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-xs font-medium text-muted-foreground">Dependents</p>
              {requirement.dependents.map((dep) => (
                <Link
                  key={dep.id}
                  href={`/projects/${projectId}/requirements/${dep.requirementId}`}
                  className="block rounded-md border p-2 text-sm transition-colors hover:bg-muted"
                >
                  <p className="truncate font-medium">
                    {dep.requirement?.title ?? dep.requirementId}
                  </p>
                  <Badge variant="outline" className="mt-1 text-[10px]">{dep.type}</Badge>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Linked Tasks */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CheckSquare className="h-4 w-4" />
            Tasks ({requirement.tasks?.length ?? 0})
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6"
              title="Add task"
              onClick={() => setTaskDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {requirement.tasks && requirement.tasks.length > 0 ? (
            requirement.tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="block w-full rounded-md border p-2 text-left text-sm transition-colors hover:bg-muted"
                onClick={() => onTaskClick(task.id)}
              >
                <p className="truncate text-left font-medium">{task.title}</p>
                <Badge
                  variant="outline"
                  className={`mt-1 text-[10px] ${taskStatusBadgeClasses[task.status] ?? "text-muted-foreground"}`}
                >
                  {taskStatusLabels[task.status] ?? task.status}
                </Badge>
              </button>
            ))
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">
              No tasks yet
            </p>
          )}
        </CardContent>
      </Card>
      <CreateTaskDialog
        projectId={projectId}
        defaultRequirementId={requirement.id}
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
      />
    </aside>
  );
}
