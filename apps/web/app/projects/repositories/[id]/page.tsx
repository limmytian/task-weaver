"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import { toast } from "sonner";
import {
  Activity,
  Archive,
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  GitBranch,
  GitFork,
  KeyRound,
  Pencil,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { QueryStatePanel } from "@/components/query-state-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RepositoryFormDialog } from "@/components/repository-form-dialog";
import type { AppRouter } from "@/trpc/routers/_app";

export default function RepositoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const repositoryQuery = trpc.repository.get.useQuery({ id, operation: "read" });
  const activityQuery = trpc.activity.list.useQuery({ entityType: "repository", entityId: id, limit: 20, offset: 0 });
  const archive = trpc.repository.archive.useMutation({
    onSuccess: async () => {
      toast.success("Repository archived");
      setConfirmArchive(false);
      await utils.repository.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const retry = trpc.repository.retryDelivery.useMutation({
    onSuccess: async () => {
      toast.success("Repository delivery queued for retry");
      await utils.repository.get.invalidate({ id, operation: "read" });
    },
    onError: (error) => toast.error(error.message),
  });

  const repository = repositoryQuery.data;
  const projectUsage = useMemo(() => {
    const projects = new Map<string, { id: string; name: string }>();
    for (const link of repository?.requirements ?? []) {
      const project = link.requirement.project;
      if (project) projects.set(project.id, { id: project.id, name: project.name });
    }
    return [...projects.values()];
  }, [repository]);
  const delivery = repository?.requirements ?? [];
  const completed = delivery.filter((link) => link.deliveryStatus === "merged" || link.deliveryStatus === "unchanged").length;
  const failed = delivery.filter((link) => link.deliveryStatus === "failed").length;

  if (repositoryQuery.isLoading) return <RepositoryDetailSkeleton />;
  if (repositoryQuery.isError || !repository) {
    return (
      <>
        <DetailHeader title="Repository" />
        <main className="mx-auto max-w-5xl p-6"><QueryStatePanel icon={<GitFork className="h-5 w-5" />} title="Repository could not be loaded" description={repositoryQuery.error?.message ?? "The repository is unavailable or not visible."} onAction={() => repositoryQuery.refetch()} /></main>
      </>
    );
  }

  const capabilities = repository.provider === "github"
    ? ["clone", "fetch", "push", "pull requests"]
    : repository.provider === "gitea"
      ? ["clone", "fetch", "push", "provider extension"]
      : ["clone", "fetch", "push"];

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`${label} could not be copied`);
    }
  };

  return (
    <>
      <DetailHeader title={repository.displayName} />
      <main className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="rounded-lg bg-primary/10 p-2 text-primary"><GitFork className="h-6 w-6" /></div>
                <h2 className="text-2xl font-semibold tracking-tight">{repository.displayName}</h2>
                <Badge variant={repository.status === "archived" ? "secondary" : "outline"}>{repository.status}</Badge>
                <Badge variant="outline">{repository.provider}</Badge>
                <Badge variant="secondary">{repository.visibility}</Badge>
              </div>
              <code className="mt-3 block break-all rounded-md bg-muted px-3 py-2 text-sm">{repository.canonicalKey}</code>
              {repository.description && <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{repository.description}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {repository.webUrl && <Button variant="outline" asChild><a href={repository.webUrl} target="_blank" rel="noreferrer">Open provider <ExternalLink className="h-4 w-4" /></a></Button>}
              <Button variant="outline" asChild><Link href="/projects/daemons"><KeyRound className="h-4 w-4" /> Configure access</Link></Button>
              <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>
              <Button variant="destructive" onClick={() => setConfirmArchive(true)} disabled={repository.status === "archived"}><Archive className="h-4 w-4" /> Archive</Button>
            </div>
          </div>
        </section>

        {delivery.length > 0 && (failed > 0 || completed > 0 && completed < delivery.length) && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
            <div><p className="font-medium">Partial repository delivery</p><p className="text-sm opacity-80">{completed} completed, {failed} failed, and {delivery.length - completed - failed} still in progress. Successful repositories will not be repeated.</p></div>
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
          <div className="space-y-5">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitBranch className="h-4 w-4" />Identity and safe endpoints</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <SummaryRow label="Host" value={repository.host} />
                <SummaryRow label="Namespace" value={repository.namespace} />
                <SummaryRow label="Name" value={repository.name} />
                <SummaryRow label="Default branch" value={repository.defaultBranch ?? "Not discovered"} />
                {repository.httpsCloneUrl && <Endpoint label="HTTPS" value={repository.httpsCloneUrl} onCopy={() => copy(repository.httpsCloneUrl!, "HTTPS endpoint")} />}
                {repository.sshCloneUrl && <Endpoint label="SSH" value={repository.sshCloneUrl} onCopy={() => copy(repository.sshCloneUrl!, "SSH endpoint")} />}
                <div className="flex flex-wrap gap-1 pt-1">{capabilities.map((capability) => <Badge key={capability} variant="secondary">{capability}</Badge>)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitFork className="h-4 w-4" />Requirement delivery</CardTitle></CardHeader>
              <CardContent>
                {delivery.length === 0 ? <p className="text-sm text-muted-foreground">Not linked to any Requirement workspace.</p> : (
                  <><div className="space-y-3 md:hidden">{delivery.map((link) => <DeliveryCard key={link.id} link={link} onRetry={() => retry.mutate({ linkId: link.id })} retrying={retry.isPending} />)}</div><div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="py-2 pr-3 font-medium">Requirement</th><th className="px-3 py-2 font-medium">Branch / commit</th><th className="px-3 py-2 font-medium">Push</th><th className="px-3 py-2 font-medium">Review / merge</th><th className="py-2 pl-3 font-medium">Action</th></tr></thead><tbody className="divide-y">{delivery.map((link) => (
                    <tr key={link.id} className="align-top"><td className="py-3 pr-3"><Link className="font-medium hover:underline" href={`/projects/${link.requirement.projectId}/requirements/${link.requirement.id}`}>{link.requirement.title}</Link><StatusBadge status={link.deliveryStatus} />{link.failureSummary && <p className="mt-1 max-w-xs text-xs text-destructive">{link.failureCode}: {link.failureSummary}</p>}</td><td className="px-3 py-3"><code className="text-xs">{link.workingBranch ?? "—"}</code><p className="mt-1 font-mono text-xs text-muted-foreground">{link.headCommit?.slice(0, 10) ?? "No commit"}</p></td><td className="px-3 py-3"><StatusBadge status={link.pushStatus} />{link.pullRequestUrl && <a className="mt-1 block text-xs text-primary hover:underline" href={link.pullRequestUrl} target="_blank" rel="noreferrer">Open PR</a>}</td><td className="px-3 py-3"><StatusBadge status={link.reviewStatus} /><span className="mx-1 text-muted-foreground">→</span><StatusBadge status={link.mergeStatus} /></td><td className="py-3 pl-3">{link.deliveryStatus === "failed" && <Button variant="outline" size="sm" onClick={() => retry.mutate({ linkId: link.id })} disabled={retry.isPending}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>}</td></tr>
                  ))}</tbody></table></div></>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" />Linked Tasks</CardTitle></CardHeader>
              <CardContent>{repository.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No Task uses this repository as an explicit scope hint.</p> : <div className="space-y-2">{repository.tasks.map((link) => <div key={link.id} className="rounded-md border p-3"><p className="text-sm font-medium">{link.task.title}</p><p className="mt-1 text-xs text-muted-foreground">{link.task.requirement?.title ?? "Requirement unavailable"} · {link.task.status}</p></div>)}</div>}</CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Access readiness</CardTitle></CardHeader>
              <CardContent><div className="flex items-center gap-2"><StatusBadge status={repository.readiness.state} /><span className="text-sm text-muted-foreground">{repository.readiness.reasonCode.replaceAll("_", " ")}</span></div><p className="mt-3 text-xs text-muted-foreground">Readiness is scoped to the current actor and node. It never reveals another principal&apos;s credential binding.</p></CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" />Derived project usage</CardTitle></CardHeader>
              <CardContent>{projectUsage.length === 0 ? <p className="text-sm text-muted-foreground">No Project currently derives usage from Requirement links.</p> : <div className="space-y-2">{projectUsage.map((project) => <Button key={project.id} asChild variant="outline" className="w-full justify-start"><Link href={`/projects/${project.id}`}>{project.name}</Link></Button>)}</div>}</CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />Recent activity</CardTitle></CardHeader>
              <CardContent>{activityQuery.isLoading ? <div className="space-y-2" role="status" aria-label="Loading repository activity"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : activityQuery.isError ? <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="text-destructive">{activityQuery.error.message}</p><Button variant="outline" size="sm" onClick={() => activityQuery.refetch()}><RefreshCw className="h-3.5 w-3.5" /> Retry activity</Button></div> : activityQuery.data?.length ? <ol className="space-y-3">{activityQuery.data.map((entry) => <li key={entry.id} className="border-l-2 pl-3"><p className="text-sm font-medium">{entry.action.replaceAll("_", " ")}</p><p className="break-all text-xs text-muted-foreground">{entry.actorId} · {formatDate(entry.createdAt)}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">No repository activity recorded yet.</p>}</CardContent>
            </Card>
          </div>
        </div>
      </main>

      <RepositoryFormDialog open={editing} onOpenChange={setEditing} repository={repository} />
      <ConfirmDialog open={confirmArchive} onOpenChange={setConfirmArchive} title="Archive repository?" description={`Archive ${repository.displayName}? Active Requirement links block this action; historical delivery and usage remain available.`} confirmLabel={archive.isPending ? "Archiving…" : "Archive"} pending={archive.isPending} destructive onConfirm={() => archive.mutate({ id })} />
    </>
  );
}

function DetailHeader({ title }: { title: string }) {
  const router = useRouter();
  return <header className="flex min-h-14 min-w-0 items-center gap-1 border-b px-2 sm:gap-2 sm:px-4"><SidebarTrigger /><Separator orientation="vertical" className="mr-1 h-4 sm:mr-2" /><Button variant="ghost" size="sm" onClick={() => router.push("/projects/repositories")} aria-label="Back to repositories"><ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Repositories</span></Button><span className="min-w-0 truncate text-sm font-medium text-muted-foreground"><span aria-hidden="true">/ </span>{title}</span></header>;
}

type DeliveryLink = inferRouterOutputs<AppRouter>["repository"]["get"]["requirements"][number];

function DeliveryCard({ link, onRetry, retrying }: { link: DeliveryLink; onRetry: () => void; retrying: boolean }) {
  return <article className="space-y-3 rounded-lg border p-3 text-sm"><div><Link className="font-medium hover:underline" href={`/projects/${link.requirement.projectId}/requirements/${link.requirement.id}`}>{link.requirement.title}</Link><div><StatusBadge status={link.deliveryStatus} /></div>{link.failureSummary && <p className="mt-2 break-words text-xs text-destructive">{link.failureCode}: {link.failureSummary}</p>}</div><dl className="grid gap-2 text-xs"><div><dt className="text-muted-foreground">Branch / commit</dt><dd><code className="break-all">{link.workingBranch ?? "—"}</code> · <span className="font-mono">{link.headCommit?.slice(0, 10) ?? "No commit"}</span></dd></div><div><dt className="text-muted-foreground">Push</dt><dd><StatusBadge status={link.pushStatus} />{link.pullRequestUrl && <a className="ml-2 text-primary hover:underline" href={link.pullRequestUrl} target="_blank" rel="noreferrer">Open PR</a>}</dd></div><div><dt className="text-muted-foreground">Review / merge</dt><dd><StatusBadge status={link.reviewStatus} /><span className="mx-1 text-muted-foreground">→</span><StatusBadge status={link.mergeStatus} /></dd></div></dl>{link.deliveryStatus === "failed" && <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>}</article>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 border-b pb-2 text-sm sm:grid-cols-[140px_1fr]"><span className="text-muted-foreground">{label}</span><span className="break-all font-medium">{value}</span></div>;
}

function Endpoint({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return <div className="flex items-center gap-2 rounded-md border p-2"><Badge variant="outline">{label}</Badge><code className="min-w-0 flex-1 break-all text-xs">{value}</code><Button variant="ghost" size="icon" onClick={onCopy} aria-label={`Copy ${label} endpoint`}><Clipboard className="h-4 w-4" /></Button></div>;
}

function StatusBadge({ status }: { status: string }) {
  const positive = ["available", "pushed", "approved", "merged", "unchanged", "complete"].includes(status);
  const negative = ["denied", "failed", "changes_requested"].includes(status);
  return <Badge variant={negative ? "destructive" : positive ? "default" : "secondary"} className="mt-1 text-[10px]">{positive && <CheckCircle2 className="mr-1 h-3 w-3" />}{status.replaceAll("_", " ")}</Badge>;
}

function formatDate(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function RepositoryDetailSkeleton() {
  return <><header className="h-14 border-b" /><main className="mx-auto max-w-7xl space-y-5 p-6"><Skeleton className="h-36 rounded-xl" /><div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-80 rounded-xl" /><Skeleton className="h-80 rounded-xl" /></div></main></>;
}
