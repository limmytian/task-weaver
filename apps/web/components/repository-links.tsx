"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { GitFork, Plus, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RepositoryFormDialog } from "@/components/repository-form-dialog";

type RepositoryLink = {
  repository: {
    id: string;
    displayName: string;
    canonicalKey: string;
    provider?: string;
  };
};

export function RepositoryChips({
  links,
  emptyLabel,
  limit = 2,
}: {
  links?: RepositoryLink[] | null;
  emptyLabel?: string;
  limit?: number;
}) {
  if (!links || links.length === 0) {
    return emptyLabel ? (
      <span className="text-[11px] text-muted-foreground">{emptyLabel}</span>
    ) : null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Repository scope">
      {links.slice(0, limit).map(({ repository }) => (
        <Badge
          key={repository.id}
          variant="outline"
          className="max-w-[12rem] gap-1 px-1.5 py-0 text-[10px] font-normal"
          title={repository.canonicalKey}
        >
          <GitFork className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{repository.displayName}</span>
        </Badge>
      ))}
      {links.length > limit && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          +{links.length - limit}
        </Badge>
      )}
    </div>
  );
}

export function RequirementRepositories({
  requirementId,
  disabled = false,
}: {
  requirementId: string;
  disabled?: boolean;
}) {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [removing, setRemoving] = useState<RepositoryLink["repository"] | null>(null);
  const [linkFeedback, setLinkFeedback] = useState<{ tone: "status" | "error"; message: string } | null>(null);
  const utils = trpc.useUtils();
  const links = trpc.repository.listForRequirement.useQuery({ requirementId });
  const catalog = trpc.repository.list.useQuery(
    { query: search || undefined, status: "active", sort: search ? "relevance" : "recently_used", page: 1, pageSize: 50 },
    { enabled: selectorOpen },
  );

  const linkedIds = useMemo(
    () => new Set(links.data?.map((item) => item.repository.id) ?? []),
    [links.data],
  );
  const choices = catalog.data?.items.filter((repository) => !linkedIds.has(repository.id)) ?? [];

  const add = trpc.repository.addToRequirement.useMutation();
  const remove = trpc.repository.removeFromRequirement.useMutation();
  const retry = trpc.repository.retryDelivery.useMutation();

  const refresh = async () => {
    await Promise.all([
      utils.repository.listForRequirement.invalidate({ requirementId }),
      utils.requirement.get.invalidate({ id: requirementId }),
      utils.requirement.list.invalidate(),
      utils.repository.invalidate(),
    ]);
  };

  const addSelected = async () => {
    setLinkFeedback(null);
    const requested = [...selected];
    const outcomes = await Promise.allSettled(requested.map((repositoryId) => add.mutateAsync({ requirementId, repositoryId })));
    const failedIds = requested.filter((_, index) => outcomes[index]?.status === "rejected");
    const succeeded = requested.length - failedIds.length;
    await refresh();
    if (failedIds.length === 0) {
      toast.success(`${succeeded} ${succeeded === 1 ? "repository" : "repositories"} linked`);
      setSelected([]);
      setSearch("");
      setSelectorOpen(false);
      return;
    }
    setSelected(failedIds);
    const message = succeeded > 0
      ? `${succeeded} linked; ${failedIds.length} failed. Successful links were preserved. Retry the remaining selections.`
      : `No repositories were linked. Retry the ${failedIds.length} remaining ${failedIds.length === 1 ? "selection" : "selections"}.`;
    setLinkFeedback({ tone: "error", message });
    toast.error(message);
  };

  const addCreated = async (repositoryId: string) => {
    try {
      await add.mutateAsync({ requirementId, repositoryId });
      await refresh();
      toast.success("Repository created and linked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Repository could not be linked");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <GitFork className="h-4 w-4" />
            Repositories ({links.data?.length ?? 0})
          </span>
          {!disabled && (
            <Button variant="ghost" size="icon-sm" onClick={() => setSelectorOpen(true)} aria-label="Link repositories">
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {links.isLoading && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">Loading repositories…</p>}
        {links.isError && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <span>{links.error.message}</span><Button size="xs" variant="outline" onClick={() => links.refetch()}><RefreshCw className="h-3 w-3" /> Retry</Button>
          </div>
        )}
        {links.data?.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No repositories are linked. The Requirement workspace will be empty until repositories are added.
          </p>
        )}
        {links.data?.map(({ link, repository }) => (
          <div key={link.id} className="rounded-md border p-2.5 text-xs">
            <div className="flex items-start gap-2">
              <Link href={`/projects/repositories/${repository.id}`} className="min-w-0 flex-1 hover:underline">
                <p className="truncate font-medium text-foreground">{repository.displayName}</p>
                <p className="truncate text-muted-foreground" title={repository.canonicalKey}>{repository.canonicalKey}</p>
              </Link>
              <Badge variant={link.deliveryStatus === "failed" ? "destructive" : ["merged", "unchanged"].includes(link.deliveryStatus) ? "outline" : "secondary"} className="shrink-0 text-[10px]">
                {link.deliveryStatus}
              </Badge>
              {!disabled && (
                <Button variant="ghost" size="icon-xs" onClick={() => setRemoving(repository)} aria-label={`Remove ${repository.displayName}`}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              <span>Branch: {link.workingBranch ?? link.baseBranch ?? repository.defaultBranch ?? "default"}</span>
              {link.headCommit && <span>Commit: {link.headCommit.slice(0, 8)}</span>}
              {link.pullRequestUrl && <a href={link.pullRequestUrl} target="_blank" rel="noreferrer" className="underline">Pull request</a>}
            </div>
            {link.failureSummary && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded bg-destructive/10 px-2 py-1.5 text-destructive">
                <span>{link.failureSummary}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={retry.isPending}
                  onClick={async () => {
                    try {
                      await retry.mutateAsync({ linkId: link.id });
                      await refresh();
                      toast.success("Delivery retry requested");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Retry could not be requested");
                    }
                  }}
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>

      <Dialog open={selectorOpen} onOpenChange={(nextOpen) => { setSelectorOpen(nextOpen); if (nextOpen) setLinkFeedback(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Link repositories</DialogTitle>
            <DialogDescription>Select one or more repositories to add to this Requirement workspace.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label="Search repositories to link" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search canonical identity, host, or name" />
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-1">
            {catalog.isLoading && <p role="status" aria-live="polite" className="p-3 text-sm text-muted-foreground">Searching…</p>}
            {catalog.isError && <div role="alert" className="flex items-center justify-between gap-2 p-3 text-sm text-destructive"><span>{catalog.error.message}</span><Button size="xs" variant="outline" onClick={() => catalog.refetch()}><RefreshCw className="h-3 w-3" /> Retry</Button></div>}
            {!catalog.isLoading && choices.length === 0 && <p className="p-3 text-sm text-muted-foreground">No available repositories match.</p>}
            {choices.map((repository) => (
              <label key={repository.id} className="flex cursor-pointer items-start gap-3 rounded p-2 hover:bg-muted">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(repository.id)}
                  onChange={(event) => setSelected((current) => event.target.checked
                    ? [...current, repository.id]
                    : current.filter((id) => id !== repository.id))}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{repository.displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{repository.canonicalKey}</span>
                </span>
                <Badge variant="outline" className="text-[10px]">{repository.provider}</Badge>
              </label>
            ))}
          </div>
          {linkFeedback && <p role={linkFeedback.tone === "error" ? "alert" : "status"} className={linkFeedback.tone === "error" ? "rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive" : "rounded-md border p-2 text-sm"}>{linkFeedback.message}</p>}
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={() => { setSelectorOpen(false); setCreateOpen(true); }}>
              <Plus className="h-4 w-4" /> Create repository
            </Button>
            <Button disabled={selected.length === 0 || add.isPending} onClick={addSelected}>
              Link selected ({selected.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RepositoryFormDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={addCreated} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Remove repository from Requirement?"
        description="Removal is blocked when Tasks, delivery history, or an active execution-slice manifest still depend on this repository."
        confirmLabel={remove.isPending ? "Removing…" : "Remove"}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove.mutateAsync({ requirementId, repositoryId: removing.id });
            await refresh();
            setRemoving(null);
            toast.success("Repository removed");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Repository could not be removed");
          }
        }}
      />
    </Card>
  );
}

export function TaskRepositoryScope({
  taskId,
  requirementId,
  disabled = false,
}: {
  taskId: string;
  requirementId?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [includeCatalog, setIncludeCatalog] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [removing, setRemoving] = useState<RepositoryLink["repository"] | null>(null);
  const [scopeFeedback, setScopeFeedback] = useState<{ tone: "status" | "error"; message: string } | null>(null);
  const utils = trpc.useUtils();
  const taskLinks = trpc.repository.listForTask.useQuery({ taskId });
  const requirementLinks = trpc.repository.listForRequirement.useQuery(
    { requirementId: requirementId! },
    { enabled: Boolean(requirementId) && open },
  );
  const catalog = trpc.repository.list.useQuery(
    { query: search || undefined, status: "active", sort: search ? "relevance" : "recently_used", page: 1, pageSize: 50 },
    { enabled: open && includeCatalog },
  );
  const add = trpc.repository.addToTask.useMutation();
  const remove = trpc.repository.removeFromTask.useMutation();

  const linkedIds = useMemo(() => new Set(taskLinks.data?.map((item) => item.repository.id) ?? []), [taskLinks.data]);
  const requirementIds = useMemo(() => new Set(requirementLinks.data?.map((item) => item.repository.id) ?? []), [requirementLinks.data]);
  const source = includeCatalog ? catalog.data?.items ?? [] : requirementLinks.data?.map((item) => item.repository) ?? [];
  const choices = source.filter((repository) => !linkedIds.has(repository.id) && (
    !search || repository.displayName.toLowerCase().includes(search.toLowerCase()) || repository.canonicalKey.toLowerCase().includes(search.toLowerCase())
  ));

  const refresh = async () => {
    await Promise.all([
      utils.repository.listForTask.invalidate({ taskId }),
      utils.task.get.invalidate({ id: taskId }),
      utils.task.list.invalidate(),
      utils.task.board.invalidate(),
      requirementId ? utils.repository.listForRequirement.invalidate({ requirementId }) : Promise.resolve(),
    ]);
  };

  const linkSelected = async () => {
    setScopeFeedback(null);
    const requested = [...selected];
    const outcomes = await Promise.allSettled(requested.map((repositoryId) => add.mutateAsync({
        taskId,
        repositoryId,
        addToRequirement: !requirementIds.has(repositoryId),
      })));
    const failedIds = requested.filter((_, index) => outcomes[index]?.status === "rejected");
    const succeeded = requested.length - failedIds.length;
    await refresh();
    if (failedIds.length === 0) {
      toast.success("Task repository scope updated");
      setSelected([]);
      setOpen(false);
      return;
    }
    setSelected(failedIds);
    const message = succeeded > 0
      ? `${succeeded} added; ${failedIds.length} failed. The successful scope changes were preserved.`
      : `No scope changes were saved. Retry the ${failedIds.length} remaining ${failedIds.length === 1 ? "selection" : "selections"}.`;
    setScopeFeedback({ tone: "error", message });
    toast.error(message);
  };

  const addCreated = async (repositoryId: string) => {
    try {
      await add.mutateAsync({ taskId, repositoryId, addToRequirement: true });
      await refresh();
      toast.success("Repository created and added to the Requirement workspace and Task scope");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Repository scope could not be updated");
    }
  };

  return (
    <section className="mt-4 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <GitFork className="h-3.5 w-3.5" /> Repository scope
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Scope hints prioritize files; they do not reduce the Requirement workspace available to the agent.
          </p>
        </div>
        {!disabled && requirementId && (
          <Button variant="outline" size="xs" onClick={() => setOpen(true)}><Plus className="h-3 w-3" /> Edit</Button>
        )}
      </div>
      <div className="mt-2 space-y-1.5">
        {taskLinks.isLoading && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">Loading Task repository scope…</p>}
        {taskLinks.isError && <div role="alert" className="flex items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"><span>{taskLinks.error.message}</span><Button size="xs" variant="outline" onClick={() => taskLinks.refetch()}><RefreshCw className="h-3 w-3" /> Retry</Button></div>}
        {taskLinks.data?.length === 0 && (
          <p className="rounded border border-dashed px-2 py-2 text-xs text-muted-foreground">
            Repository scope: unspecified. The agent can use any repository in the Requirement workspace.
          </p>
        )}
        {taskLinks.data?.map(({ repository }) => (
          <div key={repository.id} className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-xs">
            <Link href={`/projects/repositories/${repository.id}`} className="min-w-0 flex-1 truncate hover:underline" title={repository.canonicalKey}>
              {repository.displayName}
            </Link>
            {!disabled && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${repository.displayName} from Task scope`}
                disabled={remove.isPending}
                onClick={() => setRemoving(repository)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setScopeFeedback(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit Task repository scope</DialogTitle>
            <DialogDescription>
              Select from the Requirement workspace, or explicitly expand it with a catalog repository.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label="Search Task repository scope" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search repositories" />
          </div>
          <label className="flex items-start gap-2 rounded-md border p-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={includeCatalog} onChange={(event) => { setIncludeCatalog(event.target.checked); setSelected([]); }} />
            <span>
              <span className="block font-medium">Search the full repository catalog</span>
              <span className="text-muted-foreground">Selections outside the current workspace are explicitly added to the Requirement first.</span>
            </span>
          </label>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
            {(requirementLinks.isLoading || (includeCatalog && catalog.isLoading)) && <p role="status" aria-live="polite" className="p-3 text-sm text-muted-foreground">Searching…</p>}
            {requirementLinks.isError && !includeCatalog && <div role="alert" className="flex items-center justify-between gap-2 p-3 text-sm text-destructive"><span>{requirementLinks.error.message}</span><Button size="xs" variant="outline" onClick={() => requirementLinks.refetch()}><RefreshCw className="h-3 w-3" /> Retry</Button></div>}
            {catalog.isError && includeCatalog && <div role="alert" className="flex items-center justify-between gap-2 p-3 text-sm text-destructive"><span>{catalog.error.message}</span><Button size="xs" variant="outline" onClick={() => catalog.refetch()}><RefreshCw className="h-3 w-3" /> Retry</Button></div>}
            {!requirementLinks.isLoading && !(includeCatalog && catalog.isLoading) && !requirementLinks.isError && !catalog.isError && choices.length === 0 && <p className="p-3 text-sm text-muted-foreground">No repositories available.</p>}
            {choices.map((repository) => {
              const expandsWorkspace = !requirementIds.has(repository.id);
              return (
                <label key={repository.id} className="flex cursor-pointer items-start gap-3 rounded p-2 hover:bg-muted">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(repository.id)}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, repository.id]
                      : current.filter((id) => id !== repository.id))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{repository.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{repository.canonicalKey}</span>
                  </span>
                  {expandsWorkspace && <Badge variant="secondary" className="text-[10px]">Adds to Requirement</Badge>}
                </label>
              );
            })}
          </div>
          {scopeFeedback && <p role={scopeFeedback.tone === "error" ? "alert" : "status"} className={scopeFeedback.tone === "error" ? "rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive" : "rounded-md border p-2 text-sm"}>{scopeFeedback.message}</p>}
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={() => { setOpen(false); setCreateOpen(true); }}><Plus className="h-4 w-4" /> Create repository</Button>
            <Button disabled={selected.length === 0 || add.isPending} onClick={linkSelected}>Add selected ({selected.length})</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RepositoryFormDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={addCreated} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(nextOpen) => { if (!nextOpen) setRemoving(null); }}
        title="Remove repository from Task scope?"
        description="The repository remains in the Requirement workspace, but this Task will no longer prioritize it."
        confirmLabel={remove.isPending ? "Removing…" : "Remove"}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove.mutateAsync({ taskId, repositoryId: removing.id });
            await refresh();
            setRemoving(null);
            toast.success("Repository removed from Task scope");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Repository could not be removed");
          }
        }}
      />
    </section>
  );
}
