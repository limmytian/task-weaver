"use client";

import { useState } from "react";
import Link from "next/link";
import { attentionCategorySchema, type AttentionCategory } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { QueryStatePanel } from "@/components/query-state-panel";
import { SidebarTrigger } from "@/components/ui/sidebar";

const labels: Record<AttentionCategory, string> = { recovery: "Recovery decisions", failure: "Execution and delivery failures", review: "Review delivered work", blocked: "Blocking dependencies" };

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
  return <main className="min-w-0 space-y-5 p-4 md:p-6">
    <header className="flex flex-wrap items-center gap-3"><SidebarTrigger /><h1 className="text-2xl font-semibold">Needs attention</h1><Button variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh</Button><Link className="underline" href="/projects/personal">My personal tasks</Link></header>
    <p className="text-sm text-muted-foreground">Decisions available to you across authorized projects. These are shared responsibilities, not assignments. Opening this page does not approve or retry work.</p>
    <div className="flex flex-wrap gap-4">
      <label className="flex flex-col gap-1 text-sm">Category<select className="max-w-full rounded border bg-background p-2" value={category ?? ""} onChange={event => { setCategory(event.target.value ? attentionCategorySchema.parse(event.target.value) : undefined); resetPage(); }}><option value="">All categories</option>{attentionCategorySchema.options.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      <label className="flex flex-col gap-1 text-sm">Project<select className="max-w-full rounded border bg-background p-2" value={projectId} onChange={event => { setProjectId(event.target.value); resetPage(); }}><option value="">All authorized projects</option>{projectId && !projects.data?.items.some(project => project.id === projectId) && <option value={projectId}>Selected project (outside current options)</option>}{projects.data?.items.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {projects.data && projects.data.pageCount > 1 && <div className="flex items-end gap-2"><Button variant="outline" disabled={projectPage === 1} onClick={() => { setProjectPage(projectPage - 1); }}>Previous projects</Button><Button variant="outline" disabled={projectPage >= projects.data.pageCount} onClick={() => { setProjectPage(projectPage + 1); }}>More projects</Button></div>}
    </div>
    {projects.isError && <p role="alert">Project filter options are unavailable. <button className="underline" onClick={() => { void projects.refetch(); }}>Retry project list</button></p>}
    {query.isLoading && <p role="status">Loading current decisions…</p>}
    {query.isError && <QueryStatePanel title="Attention state is unknown" description="The query failed or access changed. Previous observations cannot establish that there are no decisions." onAction={() => { void query.refetch(); }} />}
    {page && <>
      <p role="status" className="text-sm text-muted-foreground">{query.isFetching ? "Refreshing observations…" : `Observed ${new Date(page.observedAt).toLocaleString()}`} · {page.items.length} on this page{page.next ? " · more available" : ""}. Counts apply only to this page. Execution and repository observations reflect your current permissions; inaccessible sources are not counted.</p>
      {!page.items.length && <QueryStatePanel title={after ? "No remaining decisions on this page" : "No matching decisions"} description="No matching conditions were observed in your current authorized scope. Personal assignments are available separately." />}
      {attentionCategorySchema.options.map(group => {
        const items = page.items.filter(item => item.category === group);
        return items.length ? <section key={group} aria-label={labels[group]} className="space-y-3"><h2 className="text-lg font-medium">{labels[group]}</h2><ul className="space-y-3">{items.map(item => <li key={item.id} className="space-y-2 rounded-lg border p-4 break-words">
          <p className="text-xs text-muted-foreground">{item.projectName} · Requirement · Revision {item.planRevision}</p><h3 className="font-medium">{item.title}</h3><p className="text-sm">{item.reason}</p><p className="text-xs text-muted-foreground">Requirement updated {new Date(item.updatedAt).toLocaleString()} · {item.canAct ? "Available to you; current guards apply at the destination" : "Read-only evidence; additional permission required to act"}</p>
          <Link className="inline-block rounded underline underline-offset-4 focus-visible:outline-2" href={`/projects/${item.projectId}/requirements/${item.requirementId}#${item.category === "blocked" ? "dependencies" : "workflow"}`}>{item.nextAction}</Link>
        </li>)}</ul></section> : null;
      })}
      <nav aria-label="Attention pages" className="flex gap-2"><Button variant="outline" disabled={!previous.length || query.isFetching} onClick={() => { setAfter(previous[previous.length - 1]); setPrevious(previous.slice(0, -1)); }}>Previous</Button><Button variant="outline" disabled={!page.next || query.isFetching} onClick={() => { setPrevious([...previous, after]); setAfter(page.next ?? undefined); }}>Next</Button></nav>
    </>}
  </main>;
}
