"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowDownAZ,
  CheckSquare,
  ClipboardList,
  FolderKanban,
  Pin,
  PinOff,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { QueryStatePanel } from "@/components/query-state-panel";

type ProjectSort = "updated" | "name" | "tasks" | "requirements";

export default function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<ProjectSort>("updated");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const utils = trpc.useUtils();
  const {
    data: projects,
    error,
    isError,
    isLoading,
    refetch,
  } = trpc.project.list.useQuery({ status: statusFilter });

  const projectIds = projects?.map((p) => p.id) ?? [];
  const {
    data: counts,
    isError: countsIsError,
    isLoading: countsLoading,
    refetch: refetchCounts,
  } = trpc.project.counts.useQuery(
    { projectIds },
    { enabled: projectIds.length > 0 },
  );
  const countsMap = useMemo(
    () => new Map(counts?.map((c) => [c.projectId, c]) ?? []),
    [counts],
  );

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = (projects ?? []).filter((project) => {
      if (pinnedOnly && !project.pinnedAt) return false;
      if (!normalizedQuery) return true;
      return (
        project.name.toLowerCase().includes(normalizedQuery) ||
        (project.description ?? "").toLowerCase().includes(normalizedQuery)
      );
    });

    return filtered.sort((a, b) => {
      if (a.pinnedAt && !b.pinnedAt) return -1;
      if (!a.pinnedAt && b.pinnedAt) return 1;
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "tasks") {
        return (countsMap.get(b.id)?.taskCount ?? 0) - (countsMap.get(a.id)?.taskCount ?? 0);
      }
      if (sortBy === "requirements") {
        return (countsMap.get(b.id)?.requirementCount ?? 0) - (countsMap.get(a.id)?.requirementCount ?? 0);
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [countsMap, pinnedOnly, projects, query, sortBy]);

  const totals = useMemo(() => {
    const projectCount = projects?.length ?? 0;
    const pinnedCount = projects?.filter((project) => project.pinnedAt).length ?? 0;
    const taskCount = counts?.reduce((sum, item) => sum + item.taskCount, 0) ?? 0;
    const requirementCount = counts?.reduce((sum, item) => sum + item.requirementCount, 0) ?? 0;
    return { projectCount, pinnedCount, taskCount, requirementCount };
  }, [counts, projects]);

  const togglePin = trpc.project.togglePin.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      utils.project.pinned.invalidate();
      utils.project.counts.invalidate();
    },
  });

  const retryAll = () => {
    refetch();
    refetchCounts();
  };

  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <FolderKanban className="h-5 w-5 text-muted-foreground" />
          Projects
        </h1>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New Project
          </Button>
        </div>
      </header>

      <div className="space-y-4 p-3 sm:p-4 md:p-6">
        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          <Metric label={statusFilter === "active" ? "Active projects" : "Archived projects"} value={totals.projectCount} />
          <Metric label="Pinned" value={totals.pinnedCount} muted={pinnedOnly} />
          <Metric label="Tasks" value={countsLoading ? "..." : totals.taskCount} />
          <Metric label="Requirements" value={countsLoading ? "..." : totals.requirementCount} />
        </div>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as "active" | "archived")}>
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="archived">
                <Archive className="mr-1 h-3.5 w-3.5" />
                Archived
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
                className="h-9 pl-9 lg:min-w-[18rem]"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center lg:ml-auto">
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as ProjectSort)}>
                <SelectTrigger className="h-9 w-full sm:w-48">
                  <ArrowDownAZ className="mr-1 h-4 w-4 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" position="popper">
                  <SelectItem value="updated">Recently updated</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="tasks">Most tasks</SelectItem>
                  <SelectItem value="requirements">Most requirements</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={pinnedOnly ? "default" : "outline"}
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setPinnedOnly((value) => !value)}
              >
                <Star className="h-4 w-4" />
                Pinned
              </Button>
            </div>
          </div>
        </div>

        {isError ? (
          <QueryStatePanel
            icon={<FolderKanban className="h-5 w-5" />}
            title="Projects could not be loaded"
            description={error.message}
            onAction={retryAll}
          />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2 rounded-lg border p-4">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <div className="flex gap-3 pt-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : projects && visibleProjects.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleProjects.map((project) => {
              const isPinned = !!project.pinnedAt;
              const projectCounts = countsMap.get(project.id);
              return (
                <div key={project.id} className="relative group">
                  <Link href={`/projects/${project.id}`}>
                    <Card className="h-full gap-3 rounded-lg py-0 transition-colors hover:border-foreground/20">
                      <CardHeader className="p-4">
                        <div className="flex items-start justify-between">
                          <CardTitle className="min-w-0 pr-10 text-base leading-snug">
                            <span className="line-clamp-2">{project.name}</span>
                          </CardTitle>
                        </div>
                        <CardDescription className="line-clamp-2">
                          {project.description || "No description"}
                        </CardDescription>
                        <div className="flex flex-wrap gap-4 pt-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <CheckSquare className="h-3 w-3" />
                            {projectCounts ? projectCounts.taskCount : countsLoading ? "..." : 0} tasks
                          </span>
                          <span className="flex items-center gap-1">
                            <ClipboardList className="h-3 w-3" />
                            {projectCounts ? projectCounts.requirementCount : countsLoading ? "..." : 0} reqs
                          </span>
                        </div>
                        <div className="pt-1 text-[11px] text-muted-foreground">
                          Updated {new Date(project.updatedAt).toLocaleDateString()}
                        </div>
                      </CardHeader>
                    </Card>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`absolute right-1.5 top-1.5 size-10 sm:right-2 sm:top-2 sm:size-7 ${isPinned ? "opacity-100" : "opacity-60 hover:opacity-100"}`}
                    title={isPinned ? "Unpin project" : "Pin project"}
                    aria-label={isPinned ? "Unpin project" : "Pin project"}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      togglePin.mutate({ id: project.id });
                    }}
                    disabled={togglePin.isPending}
                  >
                    {isPinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <QueryStatePanel
            icon={<FolderKanban className="h-5 w-5" />}
            title={query || pinnedOnly ? "No matching projects" : statusFilter === "active" ? "No active projects" : "No archived projects"}
            description={query || pinnedOnly ? "Adjust the search, pinned filter, or status tab." : statusFilter === "active" ? "Create a project when you are ready to start a new workspace." : "Archived projects will appear here."}
            actionLabel={statusFilter === "active" && !query && !pinnedOnly ? "New Project" : undefined}
            onAction={statusFilter === "active" && !query && !pinnedOnly ? () => setOpen(true) : undefined}
          />
        )}

        {countsIsError && !isLoading && (
          <QueryStatePanel
            title="Project counts are unavailable"
            description="The project list is visible, but task and requirement totals could not be refreshed."
            actionLabel="Refresh counts"
            onAction={() => refetchCounts()}
            className="min-h-24"
          />
        )}
      </div>

      <CreateProjectDialog open={open} onOpenChange={setOpen} />
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
