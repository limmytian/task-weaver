"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, FileText, CheckSquare, ClipboardList, ExternalLink, Filter, GitFork } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryStatePanel } from "@/components/query-state-panel";
import { RepositoryChips } from "@/components/repository-links";

type ResultFilter = "all" | "requirements" | "tasks" | "documents" | "repositories";
type SearchMode = "keyword" | "fulltext" | "semantic" | "hybrid";

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

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("__all__");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [searchMode, setSearchMode] = useState<SearchMode>("keyword");
  const router = useRouter();

  const { data: projects } = trpc.project.list.useQuery({});

  const { data, error, isError, isLoading, refetch } = trpc.search.all.useQuery(
    {
      query: debouncedQuery,
      projectId: projectFilter === "__all__" ? undefined : projectFilter,
      mode: searchMode,
    },
    { enabled: debouncedQuery.length > 0 },
  );

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleChange = (value: string) => {
    setQuery(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value.trim());
    }, 300);
  };

  const totalResults =
    (data?.requirements?.length ?? 0) +
    (data?.tasks?.length ?? 0) +
    (data?.documents?.length ?? 0) +
    (data?.repositories?.length ?? 0);
  const counts = useMemo(() => ({
    requirements: data?.requirements?.length ?? 0,
    tasks: data?.tasks?.length ?? 0,
    documents: data?.documents?.length ?? 0,
    repositories: data?.repositories?.length ?? 0,
  }), [data]);
  const filteredTotal =
    resultFilter === "all"
      ? totalResults
      : counts[resultFilter];
  const showRequirements = resultFilter === "all" || resultFilter === "requirements";
  const showTasks = resultFilter === "all" || resultFilter === "tasks";
  const showDocuments = resultFilter === "all" || resultFilter === "documents";
  const showRepositories = resultFilter === "all" || resultFilter === "repositories";

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <Search className="h-5 w-5 text-muted-foreground" />
          Search
        </h1>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px_170px_170px]">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search requirements, tasks, documents, and repositories..."
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Projects</SelectItem>
              {projects?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={searchMode} onValueChange={(value) => setSearchMode(value as SearchMode)}>
            <SelectTrigger>
              <SelectValue placeholder="Search mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keyword">Keyword</SelectItem>
              <SelectItem value="fulltext">Full text</SelectItem>
              <SelectItem value="hybrid">Hybrid</SelectItem>
              <SelectItem value="semantic">Semantic</SelectItem>
            </SelectContent>
          </Select>
          <Select value={resultFilter} onValueChange={(value) => setResultFilter(value as ResultFilter)}>
            <SelectTrigger>
              <Filter className="mr-1 h-4 w-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All results</SelectItem>
              <SelectItem value="requirements">Requirements</SelectItem>
              <SelectItem value="tasks">Tasks</SelectItem>
              <SelectItem value="documents">Documents</SelectItem>
              <SelectItem value="repositories">Repositories</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {debouncedQuery.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? "Searching..."
              : `${filteredTotal} visible result${filteredTotal !== 1 ? "s" : ""} for "${debouncedQuery}"`}
          </p>
        )}

        {data && debouncedQuery.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Requirements" value={counts.requirements} muted={resultFilter === "requirements"} />
            <Metric label="Tasks" value={counts.tasks} muted={resultFilter === "tasks"} />
            <Metric label="Documents" value={counts.documents} muted={resultFilter === "documents"} />
            <Metric label="Repositories" value={counts.repositories} muted={resultFilter === "repositories"} />
          </div>
        )}

        {data?.documentMetadata && debouncedQuery.length > 0 && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Document search: <span className="font-medium text-foreground">{data.documentMetadata.effectiveMode}</span>
            {data.documentMetadata.fallbackReason && (
              <> · fallback: <span className="font-medium text-foreground">{data.documentMetadata.fallbackReason}</span></>
            )}
          </div>
        )}

        {debouncedQuery.length === 0 && (
          <QueryStatePanel
            icon={<Search className="h-5 w-5" />}
            title="Search the workspace"
            description="Find requirements, tasks, documents, and visible repositories by title, body text, tags, and metadata."
          />
        )}

        {isError && (
          <QueryStatePanel
            icon={<Search className="h-5 w-5" />}
            title="Search could not be completed"
            description={error.message}
            onAction={() => refetch()}
          />
        )}

        {isLoading && debouncedQuery.length > 0 && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        )}

        {data && !isError && (
          <div className="space-y-6">
            {showRequirements && (data.requirements?.length ?? 0) > 0 && (
              <div>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <ClipboardList className="h-4 w-4" />
                  Requirements ({data.requirements!.length})
                </h2>
                <div className="space-y-2">
                  {data.requirements!.map((req) => (
                    <div
                      key={req.id}
                      className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-sm">{req.title}</p>
                            <Badge
                              variant={
                                req.status === "done"
                                  ? "outline"
                                  : req.status === "cancelled"
                                    ? "destructive"
                                    : "secondary"
                              }
                              className="text-[10px] px-1.5 py-0"
                            >
                              {requirementStatusLabels[req.status] ?? req.status}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {req.priority}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              project
                            </Badge>
                            {req.tags?.map((tag: string) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 bg-muted"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          {req.description && (
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                              {req.description}
                            </p>
                          )}
                        </div>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => router.push(`/projects/${req.projectId}/requirements/${req.id}`)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showTasks && data.tasks.length > 0 && (
              <div>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <CheckSquare className="h-4 w-4" />
                  Tasks ({data.tasks.length})
                </h2>
                <div className="space-y-2">
                  {data.tasks.map((task) => (
                    <div
                      key={task.id}
                      className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-sm">{task.title}</p>
                            <Badge
                              variant={
                                task.status === "done"
                                  ? "outline"
                                  : task.status === "cancelled"
                                    ? "destructive"
                                    : "secondary"
                              }
                              className="text-[10px] px-1.5 py-0"
                            >
                              {task.status}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {task.priority}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              project
                            </Badge>
                            {task.tags?.map((tag: string) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 bg-muted"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          {task.description && (
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                              {task.description}
                            </p>
                          )}
                          <div className="mt-1.5">
                            <RepositoryChips links={task.repositories} emptyLabel="Repository scope unspecified" />
                          </div>
                        </div>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => router.push(`/projects/${task.projectId}?task=${task.id}`)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showRepositories && data.repositories.length > 0 && (
              <div>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <GitFork className="h-4 w-4" />
                  Repositories ({data.repositories.length})
                </h2>
                <div className="space-y-2">
                  {data.repositories.map((repository) => (
                    <div key={repository.id} className="rounded-lg border p-3 transition-colors hover:bg-muted/50">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">{repository.displayName}</p>
                            <Badge variant="outline" className="text-[10px]">{repository.provider}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{repository.visibility}</Badge>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground" title={repository.canonicalKey}>
                            {repository.canonicalKey}
                          </p>
                        </div>
                        <Button size="xs" variant="outline" onClick={() => router.push(`/projects/repositories/${repository.id}`)}>
                          <ExternalLink className="h-3 w-3" /> Open
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showDocuments && data.documents.length > 0 && (
              <div>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <FileText className="h-4 w-4" />
                  Documents ({data.documents.length})
                </h2>
                <div className="space-y-2">
                  {data.documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-sm">{doc.title}</p>
                            <Badge variant={doc.projectId ? "outline" : "secondary"} className="text-[10px] px-1.5 py-0">
                              {doc.projectId ? "project" : "global"}
                            </Badge>
                            {doc.tags?.map((tag) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="text-[10px] px-1.5 py-0"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Updated {new Date(doc.updatedAt).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => router.push(`/projects/documents/${doc.id}`)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {filteredTotal === 0 && !isLoading && debouncedQuery.length > 0 && (
              <QueryStatePanel
                icon={<Search className="h-5 w-5" />}
                title="No matching results"
                description="Adjust the query, project scope, or result type filter."
              />
            )}
          </div>
        )}
      </div>
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
    <div className={`rounded-lg border bg-card px-3 py-2 ${muted ? "border-primary/40" : ""}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
