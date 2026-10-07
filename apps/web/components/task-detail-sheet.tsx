"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, StickyNote, Send, Trash2, FileText, X, ClipboardList, Plus, GitBranch, Calendar, History, Circle, Clock, Eye, CheckCircle2, Ban, ArrowRight, Network } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AssistantDialog } from "@/components/assistant-dialog";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { TaskRepositoryScope } from "@/components/repository-links";

const statusOptions = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const priorityOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const statusColors: Record<string, string> = {
  todo: "bg-muted-foreground/20",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  done: "bg-green-500",
  cancelled: "bg-destructive",
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

export function TaskDetailSheet({
  taskId,
  projectId,
  open,
  onOpenChange,
  onTaskSelect,
}: {
  taskId: string | null;
  projectId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTaskSelect?: (taskId: string) => void;
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: task } = trpc.task.get.useQuery(
    { id: taskId! },
    { enabled: !!taskId },
  );
  const effectiveProjectId = task?.projectId ?? projectId;
  const candidates = trpc.auth.assignees.useQuery(
    { projectId: effectiveProjectId ?? undefined },
    { enabled: !!task, refetchOnWindowFocus: true },
  );

  const invalidateTaskQueries = () => {
    utils.task.get.invalidate({ id: taskId! });
    if (effectiveProjectId) {
      utils.task.board.invalidate({ projectId: effectiveProjectId });
      utils.requirement.list.invalidate({ projectId: effectiveProjectId });
      utils.task.gantt.invalidate({ projectId: effectiveProjectId });
    }
    utils.task.list.invalidate();
    utils.task.listPersonal.invalidate();
  };

  const updateStatus = trpc.task.updateStatus.useMutation({
    onSuccess: () => {
      invalidateTaskQueries();
      toast.success("Task status updated");
    },
    onError: (err) => toast.error("Failed to update task status", { description: err.message }),
  });

  const updateTask = trpc.task.update.useMutation({
    onSuccess: invalidateTaskQueries,
    onError: (err) => toast.error("Failed to update task", { description: err.message }),
  });

  const deleteTask = trpc.task.delete.useMutation({
    onSuccess: () => {
      invalidateTaskQueries();
      onOpenChange(false);
      toast.success("Task cancelled");
    },
    onError: (err) => toast.error("Failed to cancel task", { description: err.message }),
  });

  const unlinkDocFromTask = trpc.document.unlinkFromTask.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId! });
    },
    onError: (err) => toast.error("Failed to unlink document", { description: err.message }),
  });

  if (!task) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="sr-only">
            <SheetTitle>Task Details</SheetTitle>
          </SheetHeader>
          <div className="flex h-40 items-center justify-center">
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-0 sm:px-6 sm:pt-6">
          <SheetTitle className="pr-10 text-left text-lg leading-snug sm:pr-8 sm:text-xl">
            {task.title}
          </SheetTitle>
          {task.requirement && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <ClipboardList className="h-3 w-3" />
              <span className="truncate">{task.requirement.title}</span>
              <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                {requirementStatusLabels[task.requirement.status] ?? task.requirement.status}
              </Badge>
            </div>
          )}
          <div className="mt-3">
            <AssistantDialog
              contextKind="task"
              projectId={effectiveProjectId}
              requirementId={task.requirementId ?? undefined}
              taskId={task.id}
              label="Ti"
            />
          </div>
          {(updateStatus.isPending || updateTask.isPending) && (
            <p className="mt-2 text-xs text-muted-foreground">Saving changes...</p>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
          {/* Status & Priority */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Status
              </label>
              <Select
                value={task.status}
                onValueChange={(value) =>
                  updateStatus.mutate({
                    id: task.id,
                    status: value as typeof task.status,
                  })
                }
                disabled={task.status === "cancelled" || updateStatus.isPending || deleteTask.isPending}
              >
                <SelectTrigger className="h-10 sm:h-9">
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full ${statusColors[task.status] ?? ""}`}
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
                value={task.priority}
                onValueChange={(value) =>
                  updateTask.mutate({
                    id: task.id,
                    data: { priority: value as typeof task.priority },
                  })
                }
                disabled={task.status === "cancelled" || updateTask.isPending}
              >
                <SelectTrigger className="h-10 sm:h-9">
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

          {/* Assignee & Expected Time */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Assignee
              </label>
              <select
                aria-label="Assignee"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:h-9"
                value={task.assignee ?? ""}
                disabled={task.status === "cancelled" || updateTask.isPending || candidates.isError || candidates.isLoading}
                onChange={(event) => {
                  const candidate = candidates.data?.find((actor) => actor.id === event.target.value);
                  updateTask.mutate({
                    id: task.id,
                    data: { assignee: candidate?.id ?? null, assigneeType: candidate?.type ?? null },
                  });
                }}
              >
                <option value="">Unassigned</option>
                {task.assignee && !candidates.data?.some((actor) => actor.id === task.assignee) && (
                  <option value={task.assignee} disabled>Previous assignee is unavailable</option>
                )}
                {candidates.data?.map((actor) => (
                  <option key={actor.id} value={actor.id}>{actor.displayName} ({actor.type})</option>
                ))}
              </select>
              {candidates.isError && <p role="alert" className="text-xs text-destructive">Eligible assignees are unavailable.</p>}
            </div>
            <div>
              <label className="mb-1.5 flex text-xs font-medium text-muted-foreground items-center gap-1.5">
                <Calendar className="h-3 w-3" />
                Expected Time
              </label>
              <Input
                type="date"
                className="h-10 sm:h-9"
                value={task.expectedAt ? new Date(task.expectedAt).toISOString().split("T")[0] : ""}
                disabled={task.status === "cancelled" || updateTask.isPending}
                onChange={(e) =>
                  updateTask.mutate({
                    id: task.id,
                    data: {
                      expectedAt: e.target.value ? new Date(e.target.value) : null,
                    },
                  })
                }
              />
            </div>
          </div>

          <Separator className="my-5" />

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Description
            </label>
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap min-h-12">
              {task.description || <span className="text-muted-foreground italic">No description</span>}
            </div>
          </div>

          {task.scope === "project" && (
            <TaskRepositoryScope
              taskId={task.id}
              requirementId={task.requirementId}
              disabled={task.status === "cancelled"}
            />
          )}

          {/* Tags */}
          <div className="mt-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Tags
            </label>
            <div className="flex flex-wrap gap-1.5">
              {task.tags?.map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="text-xs cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                  onClick={() => {
                    if (updateTask.isPending || task.status === "cancelled") return;
                    const newTags = (task.tags ?? []).filter((t) => t !== tag);
                    updateTask.mutate({ id: task.id, data: { tags: newTags } });
                  }}
                  title={`Remove "${tag}"`}
                >
                  {tag} <X className="ml-0.5 h-3 w-3" />
                </Badge>
              ))}
              <Input
                className="h-7 w-24 text-xs"
                placeholder="+ tag"
                disabled={task.status === "cancelled" || updateTask.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val && !(task.tags ?? []).includes(val)) {
                      updateTask.mutate({
                        id: task.id,
                        data: { tags: [...(task.tags ?? []), val] },
                      });
                      (e.target as HTMLInputElement).value = "";
                    }
                  }
                }}
              />
            </div>
          </div>

          <Separator className="my-5" />

          {/* Activity, Comments, Notes & Graph Tabs */}
          <Tabs defaultValue="activity">
            <TabsList className="scrollbar-none w-full justify-start overflow-x-auto">
              <TabsTrigger value="activity" className="shrink-0 sm:flex-1">
                <History className="mr-1.5 h-3.5 w-3.5" />
                Activity
              </TabsTrigger>
              <TabsTrigger value="comments" className="shrink-0 sm:flex-1">
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                Comments ({task.comments?.length ?? 0})
              </TabsTrigger>
              <TabsTrigger value="notes" className="shrink-0 sm:flex-1">
                <StickyNote className="mr-1.5 h-3.5 w-3.5" />
                Notes ({task.notes?.length ?? 0})
              </TabsTrigger>
              {effectiveProjectId && (
                <TabsTrigger value="graph" className="shrink-0 sm:flex-1">
                  <Network className="mr-1.5 h-3.5 w-3.5" />
                  Graph
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="activity" className="mt-3">
              <TaskActivityTimeline taskId={task.id} />
            </TabsContent>

            <TabsContent value="comments" className="mt-3">
              <CommentsList
                taskId={task.id}
                projectId={projectId}
                comments={task.comments ?? []}
              />
            </TabsContent>

            <TabsContent value="notes" className="mt-3">
              <NotesList
                taskId={task.id}
                projectId={projectId}
                notes={task.notes ?? []}
              />
            </TabsContent>

            {effectiveProjectId && (
              <TabsContent value="graph" className="mt-3">
                <KnowledgeGraph
                  projectId={effectiveProjectId}
                  title="Task Graph"
                  focusNodeId={task.id}
                  focusDepth={2}
                  onTaskClick={(id) => onTaskSelect?.(id)}
                />
              </TabsContent>
            )}
          </Tabs>

          {/* Linked Documents */}
          {task.documentLinks && task.documentLinks.length > 0 && (
            <div className="mt-5">
              <label className="mb-2 block text-xs font-medium text-muted-foreground">
                Linked Documents
              </label>
              <div className="space-y-1.5">
                {task.documentLinks.map((link) => (
                  <div
                    key={link.id}
                    className="flex items-center gap-2 rounded-lg border p-2.5 text-sm"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{link.document?.title ?? "Document"}</span>
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {link.linkType}
                    </Badge>
                    <button
                      aria-label="Unlink document"
                      className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                      onClick={() => unlinkDocFromTask.mutate({ linkId: link.id })}
                      disabled={unlinkDocFromTask.isPending}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {effectiveProjectId && (
            <div className="mt-5">
              <DependenciesSection
                taskId={task.id}
                projectId={effectiveProjectId}
                dependencies={task.dependencies ?? []}
              />
            </div>
          )}

          <Separator className="my-5" />

          {/* Meta */}
          <div className="text-xs text-muted-foreground">
            Created by <span className="font-medium text-foreground/70">{task.createdBy}</span> on{" "}
            {new Date(task.createdAt).toLocaleString()}
          </div>

          {/* Delete */}
          {task.status !== "cancelled" && (
            <Button
              variant="destructive"
              size="sm"
              className="mt-4 w-full"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={deleteTask.isPending || updateStatus.isPending}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {deleteTask.isPending ? "Cancelling..." : "Cancel Task"}
            </Button>
          )}
        </div>
      </SheetContent>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Cancel Task"
        description={`Are you sure you want to cancel "${task.title}"? This will set the task status to cancelled.`}
        confirmLabel="Cancel Task"
        destructive
        onConfirm={() => deleteTask.mutate({ id: task.id })}
      />
    </Sheet>
  );
}

function CommentsList({
  taskId,
  comments,
}: {
  taskId: string;
  projectId?: string;
  comments: Array<{
    id: string;
    content: string;
    authorId: string;
    authorType: string;
    createdAt: Date;
  }>;
}) {
  const [content, setContent] = useState("");
  const utils = trpc.useUtils();

  const addComment = trpc.task.addComment.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      setContent("");
    },
  });

  return (
    <div className="space-y-3">
      {comments.map((c) => (
        <div key={c.id} className="rounded-lg border p-3">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{c.authorId}</span>
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              {c.authorType}
            </Badge>
            <span>{new Date(c.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{c.content}</p>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!content.trim()) return;
          addComment.mutate({ taskId, content: content.trim() });
        }}
      >
        <Input
          placeholder="Add a comment..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="h-9 text-sm"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!content.trim() || addComment.isPending}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}

function NotesList({
  taskId,
  notes,
}: {
  taskId: string;
  projectId?: string;
  notes: Array<{
    id: string;
    content: string;
    authorId: string;
    pinned: boolean;
    createdAt: Date;
  }>;
}) {
  const [content, setContent] = useState("");
  const utils = trpc.useUtils();

  const addNote = trpc.task.addNote.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      setContent("");
    },
  });

  const sorted = [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="space-y-3">
      {sorted.map((n) => (
        <div
          key={n.id}
          className={`rounded-lg border p-3 ${n.pinned ? "border-primary/30 bg-primary/5" : ""}`}
        >
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{n.authorId}</span>
            {n.pinned && (
              <Badge variant="default" className="text-[10px] px-1 py-0">
                pinned
              </Badge>
            )}
            <span>{new Date(n.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{n.content}</p>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!content.trim()) return;
          addNote.mutate({ taskId, content: content.trim() });
        }}
      >
        <Input
          placeholder="Add a note..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="h-9 text-sm"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!content.trim() || addNote.isPending}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}

function DependenciesSection({
  taskId,
  projectId,
  dependencies,
}: {
  taskId: string;
  projectId: string;
  dependencies: Array<{
    id: string;
    type: string;
    description?: string | null;
    dependsOnTaskId: string;
    dependsOn?: { id: string; title: string; status: string } | null;
  }>;
}) {
  const [adding, setAdding] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [depType, setDepType] = useState<string>("blocks");
  const [depDescription, setDepDescription] = useState<string>("");
  const utils = trpc.useUtils();

  const { data: projectTasks } = trpc.task.list.useQuery(
    { projectId },
    { enabled: adding },
  );

  const addDependency = trpc.task.addDependency.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      setAdding(false);
      setSelectedTaskId("");
      setDepType("blocks");
      setDepDescription("");
    },
  });

  const removeDependency = trpc.task.removeDependency.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
    },
  });

  const existingDepIds = new Set(dependencies.map((d) => d.dependsOnTaskId));
  const availableTasks = projectTasks?.filter(
    (t) => t.id !== taskId && !existingDepIds.has(t.id) && t.status !== "cancelled",
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" />
          Dependencies ({dependencies.length})
        </label>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(!adding)}
        >
          {adding ? "Cancel" : <Plus className="h-3.5 w-3.5" />}
        </button>
      </div>

      {adding && (
        <div className="mb-2 space-y-2 rounded border p-2">
          <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Select task..." />
            </SelectTrigger>
            <SelectContent>
              {availableTasks?.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  {t.title}
                </SelectItem>
              ))}
              {availableTasks?.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">No tasks available</div>
              )}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Select value={depType} onValueChange={setDepType}>
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blocks">Blocks</SelectItem>
                <SelectItem value="related">Related</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Description (optional)"
            value={depDescription}
            onChange={(e) => setDepDescription(e.target.value)}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            className="h-8 w-full text-xs"
            disabled={!selectedTaskId || addDependency.isPending}
            onClick={() =>
              addDependency.mutate({
                taskId,
                dependsOnTaskId: selectedTaskId,
                type: depType as "blocks" | "related",
                description: depDescription.trim() || undefined,
              })
            }
          >
            Add
          </Button>
        </div>
      )}

      {dependencies.length > 0 && (
        <div className="space-y-1.5">
          {dependencies.map((dep) => (
            <div
              key={dep.id}
              className="rounded border p-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {dep.type}
                </Badge>
                <span className="flex-1 truncate">{dep.dependsOn?.title ?? dep.dependsOnTaskId}</span>
                <button
                  aria-label="Remove dependency"
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => removeDependency.mutate({ depId: dep.id })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {dep.description && (
                <p className="mt-1 pl-13 text-xs text-muted-foreground">{dep.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const activityStatusIcon: Record<string, React.ReactNode> = {
  todo: <Circle className="h-3 w-3 text-muted-foreground" />,
  in_progress: <Clock className="h-3 w-3 text-blue-500" />,
  in_review: <Eye className="h-3 w-3 text-amber-500" />,
  done: <CheckCircle2 className="h-3 w-3 text-green-500" />,
  cancelled: <Ban className="h-3 w-3 text-destructive" />,
};

const activityStatusLabel: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

const activityActionLabel: Record<string, string> = {
  created: "Created task",
  updated: "Updated task",
  status_changed: "Changed status",
  commented: "Added comment",
  dependency_added: "Added dependency",
  cancelled: "Cancelled task",
};

function TaskActivityTimeline({ taskId }: { taskId: string }) {
  const { data: activities, isLoading } = trpc.activity.list.useQuery({
    entityType: "task",
    entityId: taskId,
    limit: 50,
  });

  if (isLoading) {
    return (
      <div className="space-y-3 py-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No activity recorded yet.
      </p>
    );
  }

  return (
    <div className="relative space-y-0">
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
      {activities.map((entry) => {
        const meta = entry.metadata as Record<string, unknown> | null;
        const isStatusChange = entry.action === "status_changed";
        const fromStatus = meta?.from as string | undefined;
        const toStatus = meta?.to as string | undefined;

        return (
          <div
            key={entry.id}
            className="relative flex gap-3 py-2 pl-1"
          >
            <div className="relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-background">
              {isStatusChange && toStatus
                ? activityStatusIcon[toStatus] ?? <Circle className="h-3 w-3 text-muted-foreground" />
                : <History className="h-3 w-3 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium">
                  {activityActionLabel[entry.action] ?? entry.action}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(new Date(entry.createdAt))}
                </span>
              </div>
              {isStatusChange && fromStatus && toStatus && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                  <span className="text-muted-foreground">{activityStatusLabel[fromStatus] ?? fromStatus}</span>
                  <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/60" />
                  <span className="font-medium">{activityStatusLabel[toStatus] ?? toStatus}</span>
                </div>
              )}
              {meta != null && Boolean(meta.reason) && (
                <p className="mt-0.5 text-[11px] text-muted-foreground italic">
                  {String(meta.reason)}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground/60">
                {entry.actorId} · {new Date(entry.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
