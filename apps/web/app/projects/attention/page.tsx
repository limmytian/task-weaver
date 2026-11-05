"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import { attentionCategorySchema, type AttentionCategory } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { QueryStatePanel } from "@/components/query-state-panel";
import { SidebarTrigger } from "@/components/ui/sidebar";

const groups: Record<AttentionCategory, { label: string; description: string; accent: string }> = {
  recovery: { label: "Recovery decisions", description: "Review the current recovery evidence and decide how to proceed.", accent: "border-l-amber-500" },
  failure: { label: "Execution and delivery failures", description: "Inspect what failed and the available next step.", accent: "border-l-red-500" },
  review: { label: "Review delivered work", description: "Work is ready for a review or integration decision.", accent: "border-l-blue-500" },
  blocked: { label: "Blocking dependencies", description: "A dependency is preventing progress.", accent: "border-l-violet-500" },
};

export default function AttentionPage() {
  const [category, setCategory] = useState<AttentionCategory>();
  const [projectId, setProjectId] = useState("");
  const [after, setAfter] = useState<string>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [projectPage, setProjectPage] = useState(1);
  const projects = trpc.project.listSummary.useQuery({ status: "active", page: projectPage, pageSize: 50, view: "summary" });
  const query = trpc.attention.list.useQuery({ projectId: projectId || undefined, category, after, limit: 25 }, {
    retry: false, refetchInterval: 30_000, refetchOnWindowFocus: true,
  });
  const resetPage = () => { setAfter(undefined); setPrevious([]); };
  // A failed refresh hides cached rows, including after permission revocation.
  const page = query.isError ? undefined : query.data;
  return <main className="min-w-0 space-y-6 p-4 md:p-6 lg:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <SidebarTrigger className="mt-1 shrink-0" />
        <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Needs attention</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground">Shared decisions across your authorized projects. These are not assignments, and opening this page does not approve or retry work.</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-3"><Link className="rounded text-sm font-medium underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" href="/projects/personal">My personal tasks</Link><Button variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button></div>
    </header>
    <section aria-label="Filter decisions" className="rounded-xl border bg-muted/30 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium sm:min-w-48">Category<select className="h-10 w-full rounded-md border bg-background px-3 font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" value={category ?? ""} onChange={event => { setCategory(event.target.value ? attentionCategorySchema.parse(event.target.value) : undefined); resetPage(); }}><option value="">All categories</option>{attentionCategorySchema.options.map(value => <option key={value} value={value}>{groups[value].label}</option>)}</select></label>
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium sm:min-w-48">Project<select className="h-10 w-full rounded-md border bg-background px-3 font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" value={projectId} onChange={event => { setProjectId(event.target.value); resetPage(); }}><option value="">All authorized projects</option>{projectId && !projects.data?.items.some(project => project.id === projectId) && <option value={projectId}>Selected project (outside current options)</option>}{projects.data?.items.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        {projects.data && projects.data.pageCount > 1 && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={projectPage === 1} onClick={() => { setProjectPage(projectPage - 1); }}>Previous projects</Button><Button variant="outline" disabled={projectPage >= projects.data.pageCount} onClick={() => { setProjectPage(projectPage + 1); }}>More projects</Button></div>}
      </div>
      {projects.isError && <p role="alert" className="mt-3 text-sm">Project filter options are unavailable. <button className="underline underline-offset-4" onClick={() => { void projects.refetch(); }}>Retry project list</button></p>}
    </section>
    {query.isLoading && <div role="status" className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Loading current decisions…</div>}
    {query.isError && <QueryStatePanel title="Attention state is unknown" description="The query failed or access changed. Previous observations cannot establish that there are no decisions." onAction={() => { void query.refetch(); }} />}
    {page && <>
      <div role="status" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-4 text-sm"><span className="font-medium">{page.items.length} {page.items.length === 1 ? "decision" : "decisions"} on this page{page.next ? " · more available" : ""}</span><span className="text-muted-foreground">{query.isFetching ? "Refreshing observations…" : `Observed ${new Date(page.observedAt).toLocaleString()}`}</span><p className="w-full text-xs leading-5 text-muted-foreground">Counts apply only to this page. Execution and repository observations reflect your current permissions; inaccessible sources are not counted.</p></div>
      {!page.items.length && <QueryStatePanel title={after ? "No remaining decisions on this page" : "No matching decisions"} description="No matching conditions were observed in your current authorized scope. Personal assignments are available separately." />}
      {attentionCategorySchema.options.map(group => {
        const items = page.items.filter(item => item.category === group);
        return items.length ? <section key={group} aria-labelledby={`group-${group}`} className="space-y-3"><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 id={`group-${group}`} className="text-lg font-semibold">{groups[group].label}</h2><span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{items.length} on this page</span><p className="w-full text-sm text-muted-foreground">{groups[group].description}</p></div><ul className="space-y-3">{items.map(item => <li key={item.id} className={`min-w-0 break-words rounded-lg border border-l-4 bg-card p-4 shadow-sm sm:p-5 ${groups[group].accent}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">{item.projectName}</span><span aria-hidden="true">·</span><span>Requirement · Revision {item.planRevision}</span></div>
          <h3 className="mt-2 text-base font-semibold leading-snug">{item.title}</h3><div className="mt-3 space-y-1"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why it needs attention</p><p className="text-sm leading-6">{item.reason}</p></div>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t pt-3"><p className="text-xs leading-5 text-muted-foreground">Requirement updated {new Date(item.updatedAt).toLocaleString()}<br />{item.canAct ? "Available to you; current guards apply at the destination" : "Read-only evidence; additional permission required to act"}</p>
          <Link className="inline-flex items-center gap-1 rounded text-sm font-semibold text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" href={`/projects/${item.projectId}/requirements/${item.requirementId}#${item.category === "blocked" ? "dependencies" : "workflow"}`}>{item.nextAction}<ArrowRight aria-hidden="true" className="size-4 shrink-0" /></Link></div>
        </li>)}</ul></section> : null;
      })}
      <nav aria-label="Attention pages" className="flex flex-wrap gap-2"><Button variant="outline" disabled={!previous.length || query.isFetching} onClick={() => { setAfter(previous[previous.length - 1]); setPrevious(previous.slice(0, -1)); }}>Previous</Button><Button variant="outline" disabled={!page.next || query.isFetching} onClick={() => { setPrevious([...previous, after]); setAfter(page.next ?? undefined); }}>Next</Button></nav>
    </>}
  </main>;
}
