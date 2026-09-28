"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Clock, ExternalLink, FileText, Plus, Search, Tags } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateDocumentDialog } from "@/components/create-document-dialog";
import { QueryStatePanel } from "@/components/query-state-panel";

type DocumentSort = "updated" | "title" | "type" | "scope";
type DocumentTypeFilter =
  | "__all__"
  | "requirement"
  | "design"
  | "meeting"
  | "guide"
  | "reference"
  | "skill"
  | "other";

export default function DocumentsPage() {
  const [open, setOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>("__all__");
  const [query, setQuery] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState<DocumentTypeFilter>("__all__");
  const [tagFilter, setTagFilter] = useState("__all__");
  const [sortBy, setSortBy] = useState<DocumentSort>("updated");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

  const {
    data: projects,
    error: projectsError,
    isError: projectsIsError,
    refetch: refetchProjects,
  } = trpc.project.list.useQuery({});

  const {
    data: documents,
    error,
    isError,
    isLoading,
    refetch,
  } = trpc.document.list.useQuery(
    projectFilter === "__all__"
      ? {}
      : projectFilter === "__global__"
        ? { includeGlobal: true }
        : { projectId: projectFilter, includeGlobal: false },
  );

  const selectedProjectId =
    projectFilter !== "__all__" && projectFilter !== "__global__"
      ? projectFilter
      : undefined;

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    documents?.forEach((doc) => doc.tags?.forEach((tag) => tags.add(tag)));
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = (documents ?? []).filter((doc) => {
      if (docTypeFilter !== "__all__" && doc.docType !== docTypeFilter) return false;
      if (tagFilter !== "__all__" && !doc.tags?.includes(tagFilter)) return false;
      if (!normalizedQuery) return true;
      return (
        doc.title.toLowerCase().includes(normalizedQuery) ||
        doc.content.toLowerCase().includes(normalizedQuery) ||
        (doc.summary ?? "").toLowerCase().includes(normalizedQuery) ||
        (doc.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
      );
    });

    return filtered.sort((a, b) => {
      if (sortBy === "title") return a.title.localeCompare(b.title);
      if (sortBy === "type") return a.docType.localeCompare(b.docType);
      if (sortBy === "scope") {
        const aScope = a.projectId ? "project" : "global";
        const bScope = b.projectId ? "project" : "global";
        return aScope.localeCompare(bScope) || a.title.localeCompare(b.title);
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [docTypeFilter, documents, query, sortBy, tagFilter]);

  const selectedDoc = useMemo(
    () => filteredDocuments.find((doc) => doc.id === selectedDocId) ?? filteredDocuments[0],
    [filteredDocuments, selectedDocId],
  );

  const totals = useMemo(() => {
    const docs = documents ?? [];
    return {
      total: docs.length,
      global: docs.filter((doc) => !doc.projectId).length,
      project: docs.filter((doc) => doc.projectId).length,
      review: docs.filter((doc) => doc.needsReview).length,
    };
  }, [documents]);

  const retryAll = () => {
    refetch();
    refetchProjects();
  };

  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          <FileText className="h-5 w-5 text-muted-foreground" />
          Documents
        </h1>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New Document
          </Button>
        </div>
      </header>

      <div className="space-y-4 p-3 sm:p-4 md:p-6">
        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          <Metric label="Documents" value={totals.total} />
          <Metric label="Global" value={totals.global} />
          <Metric label="Project" value={totals.project} />
          <Metric label="Needs review" value={totals.review} muted={totals.review > 0} />
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_190px_150px_150px_150px]">
          <div className="relative min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              className="h-9 pl-9"
            />
          </div>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="h-9 w-full min-w-0 [&_[data-slot=select-value]]:truncate">
              <SelectValue placeholder="Global documents" />
            </SelectTrigger>
            <SelectContent style={{ maxWidth: "min(28rem, calc(100vw - 2rem))" }}>
              <SelectItem value="__all__">Global documents</SelectItem>
              <SelectItem value="__global__">Global only</SelectItem>
              {projects?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="block max-w-[24rem] truncate">{p.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={docTypeFilter} onValueChange={(value) => setDocTypeFilter(value as DocumentTypeFilter)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All types</SelectItem>
              <SelectItem value="requirement">Requirement</SelectItem>
              <SelectItem value="design">Design</SelectItem>
              <SelectItem value="meeting">Meeting</SelectItem>
              <SelectItem value="guide">Guide</SelectItem>
              <SelectItem value="reference">Reference</SelectItem>
              <SelectItem value="skill">Skill</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="h-9">
              <Tags className="mr-1 h-4 w-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All tags</SelectItem>
              {allTags.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as DocumentSort)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="title">Title</SelectItem>
              <SelectItem value="type">Type</SelectItem>
              <SelectItem value="scope">Scope</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {projectsIsError && (
          <QueryStatePanel
            title="Project filters could not be loaded"
            description={projectsError.message}
            actionLabel="Refresh filters"
            onAction={() => refetchProjects()}
            className="min-h-24"
          />
        )}

        {isError ? (
          <QueryStatePanel
            icon={<FileText className="h-5 w-5" />}
            title="Documents could not be loaded"
            description={error.message}
            onAction={retryAll}
          />
        ) : isLoading ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2 rounded-lg border p-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ))}
            </div>
            <Skeleton className="hidden h-80 rounded-lg lg:block" />
          </div>
        ) : filteredDocuments.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-2">
              {filteredDocuments.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={`w-full rounded-lg border p-4 text-left transition-colors hover:border-foreground/20 ${selectedDoc?.id === doc.id ? "border-primary/50 bg-muted/30" : "bg-card"}`}
                  onClick={() => setSelectedDocId(doc.id)}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{doc.title}</p>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {doc.docType}
                        </Badge>
                        <Badge variant={doc.projectId ? "outline" : "secondary"} className="text-[10px] px-1.5 py-0">
                          {doc.projectId ? "project" : "global"}
                        </Badge>
                        {doc.needsReview && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                            review
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {doc.summary || doc.content || "No content"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground md:justify-end">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {new Date(doc.updatedAt).toLocaleDateString()}
                      </span>
                      {doc.tags?.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <DocumentPreview doc={selectedDoc} />
          </div>
        ) : (
          <QueryStatePanel
            icon={<FileText className="h-5 w-5" />}
            title={query || docTypeFilter !== "__all__" || tagFilter !== "__all__" ? "No matching documents" : "No documents in this scope"}
            description={query || docTypeFilter !== "__all__" || tagFilter !== "__all__" ? "Adjust the search, type, tag, or project filter." : "Create a document or choose another project scope."}
            actionLabel={!query && docTypeFilter === "__all__" && tagFilter === "__all__" ? "New Document" : undefined}
            onAction={!query && docTypeFilter === "__all__" && tagFilter === "__all__" ? () => setOpen(true) : undefined}
          />
        )}
      </div>

      <CreateDocumentDialog
        open={open}
        onOpenChange={setOpen}
        projectId={selectedProjectId}
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
    <div className={`rounded-lg border bg-card px-4 py-3 ${muted ? "border-destructive/40" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function DocumentPreview({
  doc,
}: {
  doc:
    | {
        id: string;
        title: string;
        content: string;
        summary: string | null;
        keywords: string[] | null;
        docType: string;
        projectId: string | null;
        tags: string[] | null;
        updatedAt: Date | string;
        readingTimeMin?: number | null;
        needsReview?: boolean | null;
      }
    | undefined;
}) {
  if (!doc) {
    return (
      <QueryStatePanel
        icon={<FileText className="h-5 w-5" />}
        title="Select a document"
        description="Choose a document to preview its content and metadata."
        className="hidden min-h-80 xl:flex"
      />
    );
  }

  return (
    <aside className="rounded-lg border bg-card p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-7rem)] xl:overflow-auto">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-2 font-semibold">{doc.title}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {doc.docType}
            </Badge>
            <Badge variant={doc.projectId ? "outline" : "secondary"} className="text-[10px]">
              {doc.projectId ? "project" : "global"}
            </Badge>
            {doc.needsReview && (
              <Badge variant="destructive" className="text-[10px]">
                review
              </Badge>
            )}
          </div>
        </div>
        <Button asChild size="icon-sm" variant="outline" title="Open document" aria-label="Open document">
          <Link href={`/projects/documents/${doc.id}`}>
            <ExternalLink className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="mt-4 space-y-3 text-sm">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Preview</p>
          <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed">
            {doc.summary || doc.content || "No content"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>Updated {new Date(doc.updatedAt).toLocaleDateString()}</span>
          <span>{doc.readingTimeMin ? `${doc.readingTimeMin} min read` : "Reading time unavailable"}</span>
        </div>
        {doc.tags && doc.tags.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Tags</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {doc.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {doc.keywords && doc.keywords.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Keywords</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {doc.keywords.join(", ")}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
