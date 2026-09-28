"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import { toast } from "sonner";
import {
  Archive,
  ExternalLink,
  FilterX,
  GitFork,
  Grid2X2,
  List,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  RepositoryFormDialog,
  type EditableRepository,
} from "@/components/repository-form-dialog";
import type { AppRouter } from "@/trpc/routers/_app";

type CatalogView = "table" | "cards";
type CatalogSort = "relevance" | "recently_used" | "usage" | "name" | "updated";

export default function RepositoriesPage() {
  return <Suspense fallback={<RepositoryCatalogSkeleton />}><RepositoryCatalog /></Suspense>;
}

function RepositoryCatalog() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const [searchValue, setSearchValue] = useState(searchParams.get("q") ?? "");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EditableRepository | null>(null);
  const [archiving, setArchiving] = useState<EditableRepository | null>(null);

  const query = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "__all__";
  const host = searchParams.get("host") ?? "";
  const status = (searchParams.get("status") ?? "active") as "active" | "archived";
  const tagsValue = searchParams.get("tags") ?? "";
  const sort = (searchParams.get("sort") ?? "relevance").replace("-", "_") as CatalogSort;
  const page = Math.max(Number(searchParams.get("page") ?? "1"), 1);
  const pageSize = Math.min(Math.max(Number(searchParams.get("pageSize") ?? "25"), 1), 100);
  const view = (searchParams.get("view") ?? "table") as CatalogView;

  const replaceParams = useCallback((changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === "__all__") next.delete(key);
      else next.set(key, value);
    }
    const href = `${pathname}${next.toString() ? `?${next}` : ""}`;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    // Browser back/forward may change the URL independently of the debounced input.
    setSearchValue(query);
  }, [query]);
  useEffect(() => {
    if (searchValue.trim() === query) return;
    const timer = setTimeout(() => replaceParams({ q: searchValue.trim() || null, page: null }, true), 250);
    return () => clearTimeout(timer);
  }, [searchValue, query, replaceParams]);

  const tags = useMemo(() => tagsValue.split(",").map((tag) => tag.trim()).filter(Boolean), [tagsValue]);
  const result = trpc.repository.list.useQuery({
    query: query || undefined,
    provider: provider === "__all__" ? undefined : provider,
    host: host || undefined,
    status,
    tags: tags.length > 0 ? tags : undefined,
    sort,
    page,
    pageSize,
  });
  const archive = trpc.repository.archive.useMutation({
    onSuccess: async () => {
      toast.success("Repository archived");
      setArchiving(null);
      await utils.repository.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const activeFilters = [
    provider !== "__all__" ? { key: "provider", label: `Provider: ${provider}` } : null,
    host ? { key: "host", label: `Host: ${host}` } : null,
    status !== "active" ? { key: "status", label: `Status: ${status}` } : null,
    ...tags.map((tag) => ({ key: `tag:${tag}`, label: `Tag: ${tag}` })),
  ].filter((filter): filter is { key: string; label: string } => Boolean(filter));

  const clearFilter = (key: string) => {
    if (key.startsWith("tag:")) {
      const tag = key.slice(4);
      replaceParams({ tags: tags.filter((item) => item !== tag).join(",") || null, page: null });
    } else replaceParams({ [key]: null, page: null });
  };

  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="flex items-center gap-2 text-lg font-semibold"><GitFork className="h-5 w-5" />Repositories</h1>
        <Button className="ml-auto" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Add repository</span><span className="sm:hidden">Add</span>
        </Button>
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
        <section className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="grid gap-3 lg:grid-cols-[minmax(280px,1fr)_170px_190px_150px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search repositories" value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search canonical identity, host, namespace, or name" className="pl-9" />
            </div>
            <Select value={provider} onValueChange={(value) => replaceParams({ provider: value, page: null })}>
              <SelectTrigger aria-label="Filter by provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All providers</SelectItem>
                <SelectItem value="generic">Generic Git</SelectItem>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="gitea">Gitea</SelectItem>
                <SelectItem value="gitlab">GitLab</SelectItem>
              </SelectContent>
            </Select>
            <Input aria-label="Filter by host" value={host} onChange={(event) => replaceParams({ host: event.target.value || null, page: null }, true)} placeholder="Filter host" />
            <Select value={status} onValueChange={(value) => replaceParams({ status: value === "active" ? null : value, page: null })}>
              <SelectTrigger aria-label="Filter by lifecycle"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(220px,1fr)_190px_auto]">
            <Input aria-label="Filter by tags" value={tagsValue} onChange={(event) => replaceParams({ tags: event.target.value || null, page: null }, true)} placeholder="Tags, comma separated" />
            <Select value={sort} onValueChange={(value) => replaceParams({ sort: value === "relevance" ? null : value, page: null })}>
              <SelectTrigger aria-label="Sort repositories"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="relevance">Relevance</SelectItem>
                <SelectItem value="recently_used">Recently used</SelectItem>
                <SelectItem value="usage">Most used</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="updated">Recently updated</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex rounded-md border p-0.5" aria-label="Catalog view">
              <Button size="icon" variant={view === "table" ? "secondary" : "ghost"} onClick={() => replaceParams({ view: null })} aria-label="Table view"><List className="h-4 w-4" /></Button>
              <Button size="icon" variant={view === "cards" ? "secondary" : "ghost"} onClick={() => replaceParams({ view: "cards" })} aria-label="Card view"><Grid2X2 className="h-4 w-4" /></Button>
            </div>
          </div>
          {activeFilters.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {activeFilters.map((filter) => (
                <button key={filter.key} type="button" onClick={() => clearFilter(filter.key)} className="rounded-full border bg-muted px-2.5 py-1 text-xs hover:bg-muted/70" aria-label={`Remove ${filter.label}`}>
                  {filter.label} ×
                </button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => replaceParams({ provider: null, host: null, status: null, tags: null, page: null })}>
                <FilterX className="h-4 w-4" /> Clear filters
              </Button>
            </div>
          )}
        </section>

        {result.isLoading && <RepositoryRowsSkeleton />}
        {result.isError && <QueryStatePanel icon={<GitFork className="h-5 w-5" />} title="Repositories could not be loaded" description={result.error.message} onAction={() => result.refetch()} />}
        {result.data && result.data.items.length === 0 && (
          <QueryStatePanel
            icon={<GitFork className="h-5 w-5" />}
            title={query || activeFilters.length > 0 ? "No repositories match these filters" : "No repositories yet"}
            description={query || activeFilters.length > 0 ? "Remove a filter or try a broader canonical identity." : "Add a reusable repository to make it available to Requirements and Tasks."}
            actionLabel={query || activeFilters.length > 0 ? "Clear filters" : "Add repository"}
            onAction={() => query || activeFilters.length > 0
              ? replaceParams({ q: null, provider: null, host: null, status: null, tags: null, page: null })
              : setFormOpen(true)}
          />
        )}

        {result.data && result.data.items.length > 0 && (
          <>
            <p className="sr-only" role="status" aria-live="polite">Showing {result.data.items.length} of {result.data.total} repositories.</p>
            {view === "cards" ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {result.data.items.map((repository) => <RepositoryCard key={repository.id} repository={repository} onEdit={() => { setEditing(repository); setFormOpen(true); }} onArchive={() => setArchiving(repository)} />)}
              </div>
            ) : (
              <>
                <div className="grid gap-4 md:hidden">
                  {result.data.items.map((repository) => <RepositoryCard key={repository.id} repository={repository} onEdit={() => { setEditing(repository); setFormOpen(true); }} onArchive={() => setArchiving(repository)} />)}
                </div>
                <RepositoryTable repositories={result.data.items} onEdit={(repository) => { setEditing(repository); setFormOpen(true); }} onArchive={setArchiving} />
              </>
            )}
          </>
        )}

        {result.data && result.data.pageCount > 1 && (
          <nav className="flex items-center justify-between" aria-label="Repository pages">
            <p className="text-sm text-muted-foreground">Page {result.data.page} of {result.data.pageCount} · {result.data.total} repositories</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => replaceParams({ page: String(page - 1) })}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= result.data.pageCount} onClick={() => replaceParams({ page: String(page + 1) })}>Next</Button>
            </div>
          </nav>
        )}
      </main>

      <RepositoryFormDialog open={formOpen} onOpenChange={setFormOpen} repository={editing} />
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(open) => { if (!open) setArchiving(null); }}
        title="Archive repository?"
        description={`Archive ${archiving?.displayName ?? "this repository"}? Active Requirement workspace links will block the action and historical usage will be preserved.`}
        confirmLabel={archive.isPending ? "Archiving…" : "Archive"}
        destructive
        pending={archive.isPending}
        onConfirm={() => { if (archiving) archive.mutate({ id: archiving.id }); }}
      />
    </>
  );
}

type RepositoryItem = inferRouterOutputs<AppRouter>["repository"]["list"]["items"][number];

function RepositoryTable({ repositories, onEdit, onArchive }: { repositories: RepositoryItem[]; onEdit: (repository: RepositoryItem) => void; onArchive: (repository: RepositoryItem) => void }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Repository</th><th className="px-4 py-3 font-medium">Provider</th><th className="px-4 py-3 font-medium">Readiness</th><th className="px-4 py-3 font-medium">Usage</th><th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y">
            {repositories.map((repository) => (
              <tr key={repository.id} className="align-top hover:bg-muted/30">
                <td className="px-4 py-3"><Link href={`/projects/repositories/${repository.id}`} className="font-medium hover:underline">{repository.displayName}</Link><code className="mt-1 block max-w-xl break-all text-xs text-muted-foreground">{repository.canonicalKey}</code><TagList tags={repository.tags} /></td>
                <td className="px-4 py-3"><Badge variant="outline">{repository.provider}</Badge><p className="mt-1 text-xs text-muted-foreground">{repository.host}</p></td>
                <td className="px-4 py-3"><Readiness state={repository.readiness.state} reason={repository.readiness.reasonCode} /></td>
                <td className="px-4 py-3 text-muted-foreground">{repository.usageCount} Requirements</td>
                <td className="px-4 py-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" aria-label={`Edit ${repository.displayName}`} onClick={() => onEdit(repository)}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label={`Archive ${repository.displayName}`} onClick={() => onArchive(repository)} disabled={repository.status === "archived"}><Archive className="h-4 w-4" /></Button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RepositoryCard({ repository, onEdit, onArchive }: { repository: RepositoryItem; onEdit: () => void; onArchive: () => void }) {
  return (
    <article className="flex min-h-56 flex-col rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><GitFork className="h-5 w-5" /></div><div className="min-w-0 flex-1"><Link href={`/projects/repositories/${repository.id}`} className="font-semibold hover:underline">{repository.displayName}</Link><code className="mt-1 block break-all text-xs text-muted-foreground">{repository.canonicalKey}</code></div><Badge variant={repository.status === "archived" ? "secondary" : "outline"}>{repository.status}</Badge></div>
      <div className="mt-4 flex flex-wrap gap-2"><Badge variant="outline">{repository.provider}</Badge><Readiness state={repository.readiness.state} reason={repository.readiness.reasonCode} /></div>
      <TagList tags={repository.tags} />
      <p className="mt-auto pt-4 text-xs text-muted-foreground">Used by {repository.usageCount} Requirements</p>
      <div className="mt-3 flex flex-wrap gap-2 border-t pt-3"><Button variant="outline" size="sm" asChild><Link href={`/projects/repositories/${repository.id}`}>Open <ExternalLink className="h-3.5 w-3.5" /></Link></Button><Button variant="ghost" size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button><Button variant="ghost" size="sm" aria-label={`Archive ${repository.displayName}`} onClick={onArchive} disabled={repository.status === "archived"}><Archive className="h-3.5 w-3.5" /> Archive</Button></div>
    </article>
  );
}

function Readiness({ state, reason }: { state: string; reason: string }) {
  return <Badge variant={state === "available" ? "default" : state === "denied" ? "destructive" : "secondary"} title={reason}><ShieldCheck className="mr-1 h-3 w-3" />{state.replace("_", " ")}</Badge>;
}

function TagList({ tags }: { tags: string[] | null }) {
  if (!tags?.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1">{tags.slice(0, 3).map((tag) => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}{tags.length > 3 && <Badge variant="secondary" className="text-[10px]">+{tags.length - 3}</Badge>}</div>;
}

function RepositoryRowsSkeleton() {
  return <div className="space-y-2" role="status" aria-live="polite" aria-label="Loading repositories"><span className="sr-only">Loading repository catalog…</span>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)}</div>;
}

function RepositoryCatalogSkeleton() {
  return <><header className="h-14 border-b" /><main className="mx-auto max-w-7xl space-y-5 p-6"><Skeleton className="h-28 rounded-xl" /><RepositoryRowsSkeleton /></main></>;
}
