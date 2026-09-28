"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Plus,
  History,
  Settings,
  Save,
  ClipboardList,
  BarChart3,
  Network,
  LayoutGrid,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Clock,
  Tag,
  GitBranch,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { CreateRequirementDialog } from "@/components/create-requirement-dialog";
import { TaskDetailSheet } from "@/components/task-detail-sheet";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HealthDashboard } from "@/components/health-dashboard";
import { GanttChart } from "@/components/gantt-chart";
import { RequirementsHeatmap } from "@/components/requirements-heatmap";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { KanbanBoard } from "@/components/kanban-board";
import { DependencyDag, type DependencyDagEdge, type DependencyDagNode } from "@/components/dependency-dag";
import { AssistantDialog } from "@/components/assistant-dialog";
import { ProjectWorkspaceLinks, WorkspaceBreadcrumbs } from "@/components/project-navigation";
import { RepositoryChips } from "@/components/repository-links";

const reqStatusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  approved: "default",
  in_progress: "default",
  in_review: "secondary",
  ready_to_merge: "default",
  done: "outline",
  cancelled: "destructive",
  archived: "secondary",
};

const reqStatusLabels: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In Progress",
  in_review: "In Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskDialogReqId, setTaskDialogReqId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: project, isLoading: projectLoading } =
    trpc.project.get.useQuery({ id });

  const openCreateTask = (requirementId?: string) => {
    setTaskDialogReqId(requirementId);
    setTaskDialogOpen(true);
  };

  if (projectLoading) {
    return (
      <>
        <header className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="mt-3 space-y-2">
            <Skeleton className="h-6 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
        </header>
        <div className="p-4 md:p-6">
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-muted-foreground">Project not found</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/projects")}>
          Back to Projects
        </Button>
      </div>
    );
  }

  return (
    <>
      <header className="border-b px-4 py-3">
        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to projects">
            <Link href="/projects">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <WorkspaceBreadcrumbs
            items={[
              { label: "Projects", href: "/projects" },
              { label: project.name },
            ]}
            className="min-w-0 flex-1"
          />
          <Badge
            variant={project.status === "active" ? "default" : "secondary"}
            className="hidden text-xs sm:inline-flex"
          >
            {project.status}
          </Badge>
          <div className="col-span-3 mt-1 flex w-full items-center gap-2 sm:col-auto sm:mt-0 sm:ml-auto sm:w-auto">
            <AssistantDialog
              contextKind="project"
              projectId={id}
              label="Ti"
              triggerClassName="flex-1 sm:flex-none"
            />
            <Button
              size="sm"
              variant="outline"
              className="flex-1 sm:flex-none"
              onClick={() => setReqDialogOpen(true)}
            >
              <Plus className="mr-1 h-4 w-4" />
              Requirement
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{project.name}</h1>
            {project.description && (
              <p className="mt-1 line-clamp-2 max-w-3xl text-sm text-muted-foreground">
                {project.description}
              </p>
            )}
          </div>
          <ProjectWorkspaceLinks projectId={id} active="workspace" className="w-full sm:w-auto" />
        </div>
      </header>

      <div className="min-w-0 flex-1 overflow-hidden p-3 sm:p-4 md:p-6">
        <Tabs defaultValue="board">
          <TabsList className="scrollbar-none h-10 max-w-full flex-nowrap justify-start overflow-x-auto">
            <TabsTrigger value="board">
              <LayoutGrid className="mr-1 h-3.5 w-3.5" />
              Board
            </TabsTrigger>
            <TabsTrigger value="timeline">
              <Clock className="mr-1 h-3.5 w-3.5" />
              Timeline
            </TabsTrigger>
            <TabsTrigger value="requirements">Requirements</TabsTrigger>
            <TabsTrigger value="analytics">
              <BarChart3 className="mr-1 h-3.5 w-3.5" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="dag">
              <GitBranch className="mr-1 h-3.5 w-3.5" />
              DAG
            </TabsTrigger>
            <TabsTrigger value="graph">
              <Network className="mr-1 h-3.5 w-3.5" />
              Graph
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="requirements" className="mt-4">
            <RequirementsTab
              projectId={id}
              onCreateTask={openCreateTask}
            />
          </TabsContent>

          <TabsContent value="board" className="mt-4">
            <KanbanBoard
              projectId={id}
              onTaskClick={(taskId) => setSelectedTaskId(taskId)}
            />
          </TabsContent>

          <TabsContent value="timeline" className="mt-4">
            <GanttChart projectId={id} title="Board Timeline" />
          </TabsContent>

          <TabsContent value="analytics" className="mt-4">
            <AnalyticsTab projectId={id} />
          </TabsContent>

          <TabsContent value="dag" className="mt-4">
            <ProjectRequirementDag projectId={id} />
          </TabsContent>

          <TabsContent value="graph" className="mt-4">
            <KnowledgeGraph projectId={id} onTaskClick={setSelectedTaskId} />
          </TabsContent>

          <TabsContent value="activity" className="mt-4">
            <ActivityLog projectId={id} />
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <ProjectSettings project={project} />
          </TabsContent>
        </Tabs>
      </div>

      <CreateTaskDialog
        projectId={id}
        defaultRequirementId={taskDialogReqId}
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
      />
      <CreateRequirementDialog
        projectId={id}
        open={reqDialogOpen}
        onOpenChange={setReqDialogOpen}
      />
      <TaskDetailSheet
        taskId={selectedTaskId}
        projectId={id}
        open={!!selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
        onTaskSelect={setSelectedTaskId}
      />
    </>
  );
}

function AnalyticsTab({ projectId }: { projectId: string }) {
  const sections = [
    {
      key: "health",
      label: "Health",
      content: <HealthDashboard projectId={projectId} />,
    },
    {
      key: "timeline",
      label: "Timeline",
      content: <GanttChart projectId={projectId} />,
    },
    {
      key: "heatmap",
      label: "Heatmap",
      content: <RequirementsHeatmap projectId={projectId} />,
    },
  ];

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <div key={section.key}>{section.content}</div>
      ))}
    </div>
  );
}

function ProjectRequirementDag({ projectId }: { projectId: string }) {
  const { data: requirements, isLoading } = trpc.requirement.list.useQuery({ projectId });

  const graph = useMemo(() => {
    if (!requirements) return { nodes: [], edges: [] };

    const nodeMap = new Map<string, DependencyDagNode>();
    const edges: DependencyDagEdge[] = [];

    for (const req of requirements) {
      type ReqTask = { id: string; status: string };
      const tasks: ReqTask[] = (req as typeof req & { tasks?: ReqTask[] }).tasks ?? [];
      const done = tasks.filter((task) => task.status === "done").length;
      const taskMeta = tasks.length > 0 ? `${done}/${tasks.length} tasks done` : "No tasks";
      nodeMap.set(req.id, {
        id: req.id,
        title: req.title,
        status: req.status,
        priority: req.priority,
        href: `/projects/${projectId}/requirements/${req.id}`,
        meta: taskMeta,
      });
    }

    for (const req of requirements) {
      for (const dep of req.dependencies ?? []) {
        if (!nodeMap.has(dep.dependsOnRequirementId) && dep.dependsOn) {
          nodeMap.set(dep.dependsOnRequirementId, {
            id: dep.dependsOnRequirementId,
            title: dep.dependsOn.title,
            status: dep.dependsOn.status,
            href: `/projects/${projectId}/requirements/${dep.dependsOnRequirementId}`,
            external: true,
            meta: "Outside recent activity",
          });
        }

        edges.push({
          id: dep.id,
          source: dep.dependsOnRequirementId,
          target: req.id,
          type: dep.type,
        });
      }
    }

    return { nodes: Array.from(nodeMap.values()), edges };
  }, [projectId, requirements]);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Recent active requirements DAG</h2>
        <p className="text-xs text-muted-foreground">
          Arrows point from blockers to the requirements that depend on them.
        </p>
      </div>
      <DependencyDag
        nodes={graph.nodes}
        edges={graph.edges}
        isLoading={isLoading}
        emptyLabel="No recent active requirements yet."
      />
    </div>
  );
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { in_progress: 0, in_review: 1, ready_to_merge: 2, approved: 3, draft: 4, done: 5, cancelled: 6, archived: 7 };

function RequirementsTab({
  projectId,
  onCreateTask,
}: {
  projectId: string;
  onCreateTask: (requirementId: string) => void;
}) {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [sortBy, setSortBy] = useState<"created" | "priority" | "expected" | "status">("created");
  const [sortAsc, setSortAsc] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>("__all__");
  const { data: requirements, isLoading } =
    trpc.requirement.list.useQuery({
      projectId,
      completedWithinDays: showAllCompleted ? 0 : undefined,
    });

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    requirements?.forEach((r) => r.tags?.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [requirements]);

  const filtered = useMemo(() => {
    let list = requirements?.filter((r) =>
      showArchived ? r.status === "archived" : r.status !== "archived"
    );
    if (list && tagFilter !== "__all__") {
      list = list.filter((r) => r.tags?.includes(tagFilter));
    }
    if (!list) return list;
    const sorted = [...list].sort((a, b) => {
      if (sortBy === "priority") {
        return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
      }
      if (sortBy === "status") {
        return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      }
      if (sortBy === "expected") {
        const aDate = a.expectedAt ? new Date(a.expectedAt).getTime() : Infinity;
        const bDate = b.expectedAt ? new Date(b.expectedAt).getTime() : Infinity;
        return aDate - bDate;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return sortAsc ? sorted.reverse() : sorted;
  }, [requirements, showArchived, sortBy, sortAsc, tagFilter]);

  const summary = useMemo(() => {
    const list = requirements ?? [];
    const active = list.filter((r) => !["archived", "cancelled", "done"].includes(r.status)).length;
    const done = list.filter((r) => r.status === "done").length;
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 86_400_000);
    const dueSoon = list.filter((r) => {
      if (!r.expectedAt || ["archived", "cancelled", "done"].includes(r.status)) return false;
      const expected = new Date(r.expectedAt);
      return expected >= now && expected <= weekFromNow;
    }).length;
    const tasks = list.flatMap((r) => {
      type TaskEntry = { id: string; status: string };
      return ((r as typeof r & { tasks?: TaskEntry[] }).tasks ?? []);
    });
    const completedTasks = tasks.filter((task) => task.status === "done").length;
    const repositoryCount = new Set(
      list.flatMap((requirement) => requirement.repositories.map((link) => link.repository.id)),
    ).size;
    return {
      active,
      done,
      dueSoon,
      repositoryCount,
      taskProgress: tasks.length > 0 ? `${completedTasks}/${tasks.length}` : "0/0",
    };
  }, [requirements]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  const archivedCount = requirements?.filter((r) => r.status === "archived").length ?? 0;

  if (!requirements || requirements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <ClipboardList className="mb-3 h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No requirements yet. Create one to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
        <RequirementMetric label="Active requirements" value={summary.active} />
        <RequirementMetric label="Done" value={summary.done} />
        <RequirementMetric label="Due in 7 days" value={summary.dueSoon} muted={summary.dueSoon > 0} />
        <RequirementMetric label="Repositories in use" value={summary.repositoryCount} />
        <RequirementMetric label="Task progress" value={summary.taskProgress} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(archivedCount > 0 || showArchived) && (
          <>
            <button
              className={`text-xs px-2 py-1 rounded-md transition-colors ${!showArchived ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setShowArchived(false)}
            >
              Active
            </button>
            <button
              className={`text-xs px-2 py-1 rounded-md transition-colors ${showArchived ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setShowArchived(true)}
            >
              Archived ({archivedCount})
            </button>
            <Separator orientation="vertical" className="mx-1 h-4" />
          </>
        )}
        <button
          onClick={() => setShowAllCompleted((v) => !v)}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${showAllCompleted ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Clock className="h-3 w-3" />
          {showAllCompleted ? "All completed" : "Recent 14d"}
        </button>
        <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1 sm:ml-auto sm:flex sm:w-auto">
          {allTags.length > 0 && (
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="h-10 w-full min-w-0 text-xs sm:h-7 sm:w-[120px]">
                <Tag className="mr-1 h-3 w-3 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Tags</SelectItem>
                {allTags.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="h-10 w-full min-w-0 text-xs sm:h-7 sm:w-[140px]">
              <ArrowUpDown className="mr-1 h-3 w-3 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created">Created Time</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="expected">Expected Time</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 sm:size-7"
            onClick={() => setSortAsc((prev) => !prev)}
            title={sortAsc ? "Ascending" : "Descending"}
          >
            {sortAsc ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {filtered && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ClipboardList className="mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {showArchived ? "No archived requirements" : "No active requirements"}
          </p>
        </div>
      )}

      {(filtered ?? []).map((req) => {
        type TaskEntry = { id: string; status: string };
        const tasks: TaskEntry[] = (req as typeof req & { tasks?: TaskEntry[] }).tasks ?? [];
        const total = tasks.length;
        const done = tasks.filter((t) => t.status === "done").length;
        const inProgress = tasks.filter((t) => t.status === "in_progress").length;
        const inReview = tasks.filter((t) => t.status === "in_review").length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        return (
          <div
            key={req.id}
            className="group rounded-lg border bg-card transition-colors hover:bg-accent/30 cursor-pointer"
            onClick={() => router.push(`/projects/${projectId}/requirements/${req.id}`)}
          >
            <div className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <p className="min-w-0 basis-full truncate font-medium sm:basis-auto">{req.title}</p>
                  <Badge variant={reqStatusColors[req.status] ?? "secondary"} className="shrink-0 text-[10px]">
                    {reqStatusLabels[req.status] ?? req.status}
                  </Badge>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {req.priority}
                  </Badge>
                  {req.expectedAt && (
                    <span className="shrink-0 text-[11px] text-muted-foreground sm:ml-auto">
                      Due {new Date(req.expectedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {req.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {req.description}
                  </p>
                )}

                <div className="mt-1.5">
                  <RepositoryChips links={req.repositories} emptyLabel="No repository workspace" limit={3} />
                </div>

                {total > 0 && (
                  <div className="mt-2 flex items-center gap-3">
                    <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      {done > 0 && (
                        <div
                          className="bg-green-500 transition-all"
                          style={{ width: `${(done / total) * 100}%` }}
                        />
                      )}
                      {inReview > 0 && (
                        <div
                          className="bg-amber-500 transition-all"
                          style={{ width: `${(inReview / total) * 100}%` }}
                        />
                      )}
                      {inProgress > 0 && (
                        <div
                          className="bg-blue-500 transition-all"
                          style={{ width: `${(inProgress / total) * 100}%` }}
                        />
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {done}/{total} ({pct}%)
                    </span>
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0 sm:size-7"
                title="Add task"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateTask(req.id);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RequirementMetric({
  label,
  value,
  muted,
}: {
  label: string;
  value: number | string;
  muted?: boolean;
}) {
  return (
    <div className={`rounded-lg border bg-card px-3 py-2 ${muted ? "border-primary/40" : ""}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

const actionLabels: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  status_changed: "Changed status",
  commented: "Commented",
  linked: "Linked",
  task_linked: "Linked task",
  document_linked: "Linked document",
  dependency_added: "Added dependency",
  cancelled: "Cancelled",
  archived: "Archived",
};

const entityLabels: Record<string, string> = {
  project: "Project",
  task: "Task",
  document: "Document",
  requirement: "Requirement",
};

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

function ActivityLog({ projectId }: { projectId: string }) {
  const pageSize = 50;
  const [page, setPage] = useState(0);
  const { data: activities, isLoading } = trpc.activity.list.useQuery({
    projectId,
    limit: pageSize,
    offset: page * pageSize,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <div className="space-y-3">
        <p className="py-10 text-center text-sm text-muted-foreground">
          {page === 0 ? "No activity yet." : "No more activity on this page."}
        </p>
        {page > 0 && (
          <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(0, value - 1))}>
            Previous page
          </Button>
        )}
      </div>
    );
  }

  let lastDateStr = "";

  return (
    <div className="space-y-3">
      <div className="relative space-y-0">
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
        {activities.map((entry) => {
          const entryDate = new Date(entry.createdAt);
          const dateStr = entryDate.toLocaleDateString();
          const showDateHeader = dateStr !== lastDateStr;
          // eslint-disable-next-line react-hooks/immutability
          lastDateStr = dateStr;
          const meta = entry.metadata as Record<string, unknown> | null;
          const isStatusChange = entry.action === "status_changed";

          return (
            <div key={entry.id}>
              {showDateHeader && (
                <div className="relative ml-6 pb-1 pt-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {entryDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                </div>
              )}
              <div className="relative flex gap-3 py-1.5 pl-1">
                <div className="relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-background">
                  <History className="h-3 w-3 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">
                      {actionLabels[entry.action] ?? entry.action}
                    </span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      {entityLabels[entry.entityType] ?? entry.entityType}
                    </Badge>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {formatRelativeTime(entryDate)}
                    </span>
                  </div>
                  {isStatusChange && meta != null && Boolean(meta.from) && Boolean(meta.to) && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {String(meta.from)}{" -> "}{String(meta.to)}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">
                    {entry.actorId} · {entryDate.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => setPage((value) => Math.max(0, value - 1))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">Page {page + 1}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={activities.length < pageSize}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function ProjectSettings({
  project,
}: {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
  };
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const router = useRouter();
  const utils = trpc.useUtils();

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      utils.project.get.invalidate({ id: project.id });
      utils.project.list.invalidate();
    },
  });

  const deleteProject = trpc.project.delete.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      utils.project.pinned.invalidate();
      router.push("/projects");
      toast.success("Project deleted");
    },
    onError: (err) => toast.error("Failed to delete project", { description: err.message }),
  });

  const handleSave = () => {
    updateProject.mutate({
      id: project.id,
      data: {
        name: name.trim(),
        description: description.trim() || undefined,
      },
    });
  };

  const handleStatusChange = (status: string) => {
    updateProject.mutate({
      id: project.id,
      data: { status: status as "active" | "archived" },
    });
  };

  return (
    <div className="max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" />
            Project Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Status</label>
            <Select
              value={project.status}
              onValueChange={handleStatusChange}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={handleSave}
            disabled={updateProject.isPending || !name.trim()}
          >
            <Save className="mr-1 h-4 w-4" />
            {updateProject.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Permanently delete this project and all its requirements, tasks, and documents. This action cannot be undone.
          </p>
          <Button
            variant="destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteProject.isPending}
          >
            {deleteProject.isPending ? "Deleting..." : "Delete Project"}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Project"
        description={`Are you sure you want to permanently delete "${project.name}"? All requirements, tasks, and documents under this project will be removed. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteProject.mutate({ id: project.id })}
      />
    </div>
  );
}
