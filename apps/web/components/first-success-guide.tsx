"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { firstSuccessSamplePlan, SAMPLE_PROJECT_NAME, SAMPLE_PROJECT_DESCRIPTION } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { useWebIdentity } from "@/components/web-identity-provider";
import { Button } from "@/components/ui/button";
import { QueryStatePanel } from "@/components/query-state-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CapabilityReadinessPanel } from "@/components/capability-readiness-panel";

export function FirstSuccessStart() {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const create = trpc.project.create.useMutation({ onSuccess: project => { setConfirm(false); router.push(`/projects/${project.id}/first-success`); }, onError: () => toast.error("Could not create sample project. Check project creation permission.") });
  return <section aria-label="First successful collaboration" className="space-y-3 rounded-lg border p-4">
    <h2 className="font-semibold">Your first successful collaboration</h2>
    <p className="text-sm text-muted-foreground">Create or open a project, then follow its First success guide to plan, deliver and review one outcome. Planning works before agent setup.</p>
    <Button variant="outline" disabled={create.isPending} onClick={() => setConfirm(true)}>Try an isolated sample</Button>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Create a sample project?" description="This explicitly creates a separate project marked [Sample]. Its plan remains staged until you review and apply it. No agent runs or credentials are created. You can archive the sample project from its guide." confirmLabel="Create sample project" pending={create.isPending} onConfirm={() => create.mutate({ name: SAMPLE_PROJECT_NAME, description: SAMPLE_PROJECT_DESCRIPTION })} />
  </section>;
}

export function FirstSuccessGuide({ projectId }: { projectId: string }) {
  const actor = useWebIdentity();
  const router = useRouter();
  const query = trpc.firstSuccess.state.useQuery({ projectId }, { retry: false, refetchOnWindowFocus: true, refetchInterval: 30_000 });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const key = `tw:first-success:${actor.id}:${projectId}`;
  const snapshot = useSyncExternalStore(subscribePreferences, () => readPreferences(key), () => "");
  const preferences = parsePreferences(snapshot);
  const save = (next: typeof preferences) => {
    const value = JSON.stringify(next);
    preferenceFallback.set(key, value);
    try { localStorage.setItem(key, value); } catch { /* In-memory preferences still work when storage is disabled. */ }
    window.dispatchEvent(new Event("tw:first-success-preferences"));
  };
  const stage = trpc.plan.createDraft.useMutation({ onSuccess: draft => router.push(`/projects/${projectId}/plans/${draft.id}`), onError: () => toast.error("Unable to stage a plan. Check current project access and retry.") });
  const archive = trpc.project.delete.useMutation({ onSuccess: () => { setArchiveOpen(false); void query.refetch(); toast.success("Sample project archived. Its records are retained."); }, onError: () => toast.error("Unable to archive the sample. Check current project management permission.") });
  if (snapshot === "") return <p role="status">Loading guide preferences…</p>;
  if (query.isError) return <QueryStatePanel title="First-success state is unavailable" description="Access may have changed. Current progress is unknown; cached steps cannot establish completion." onAction={() => { void query.refetch(); }} />;
  const state = query.data;
  if (!state) return <p role="status">Loading current project progress…</p>;
  if (preferences.hidden) return <Button variant="outline" onClick={() => save({ ...preferences, hidden: false })}>Show first-success guide</Button>;
  const requirement = state.requirement;
  const requirementHref = requirement ? `/projects/${projectId}/requirements/${requirement.id}` : `/projects/${projectId}`;
  const newPlan = () => stage.mutate({ plan: state.sample && !state.requirement && !state.appliedPlan ? firstSuccessSamplePlan(projectId) : { projectId, documents: [], requirements: [], requirementDependencies: [], taskDependencies: [], documentLinks: [], documentTaskLinks: [], documentRequirementLinks: [] } });
  return <section aria-label="First-success guide" className="space-y-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2"><h1 className="mr-auto text-xl font-semibold">First success</h1><Button variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh progress</Button><Button variant="ghost" onClick={() => save({ ...preferences, hidden: true })}>Hide guide</Button></div>
    <p className="text-sm text-muted-foreground">Progress follows real project records. Refresh or return here to resume. Optional agent setup never blocks planning. Opening this guide starts no work.</p>
    {!state.active && <p role="status">Archived project: records are retained and this guide is read-only. Restore from project settings if needed.</p>}
    {!state.canWrite && state.active && <p role="status">Read-only project access. Ask a project owner for the existing write permission to prepare or apply work.</p>}
    {state.sample && <p className="rounded bg-muted p-3 text-sm">Sample project — isolated practice data. Applying the example creates one draft requirement and one task here. You still approve the requirement and review its output explicitly.</p>}
    <ol className="list-inside list-decimal space-y-4">
      <li><strong>Describe one goal — project exists</strong><p className="text-sm text-muted-foreground">Use a short outcome and acceptance criteria. <Link className="underline" href={`/projects/${projectId}`}>Open project and requirements</Link></p></li>
      <li><strong>Prepare and apply a plan — {state.appliedPlan ? "an applied plan is recorded" : requirement ? "existing requirement available" : "not yet applied"}</strong><p className="text-sm text-muted-foreground">Review the exact draft, validate it, then explicitly apply it. You can discard a draft without creating live work.</p>
        {state.draftId ? <Link className="underline" href={`/projects/${projectId}/plans/${state.draftId}`}>Resume saved plan draft</Link> : <Button className="mt-2" variant="outline" disabled={!state.canWrite || stage.isPending} onClick={newPlan}>{state.sample && !state.requirement && !state.appliedPlan ? "Stage the sample plan" : "Prepare a plan draft"}</Button>}
      </li>
      <li><strong>Approve the intended requirement — {requirement ? requirement.status : "no requirement yet"}</strong><p className="text-sm text-muted-foreground">{requirement ? `Following the most recently updated requirement: ${requirement.title}.` : "Apply a plan or create a requirement first."} A draft is not executable. Inspect scope, tasks and permissions before changing it to Approved.</p>{requirement && <Link className="underline" href={requirementHref}>Inspect requirement and task plan</Link>}</li>
      <li><strong>Connect an agent — optional{preferences.skipAgent ? ", skipped for now" : ""}</strong><p className="text-sm text-muted-foreground">You can complete the written sample yourself. For code work, link the repository on the requirement and inspect repository credential readiness, scoped API-key grants and executor diagnostics. Configuration presence is not proof that execution is authorized.</p><div className="mt-2 flex flex-wrap gap-3"><Link className="underline" href="/projects/repositories">Repository readiness</Link><Link className="underline" href="/projects/settings/api-keys">Scoped credentials</Link><Link className="underline" href="/projects/daemons">Executor diagnostics</Link><Button variant="outline" onClick={() => save({ ...preferences, skipAgent: !preferences.skipAgent })}>{preferences.skipAgent ? "Show optional setup" : "Skip agent setup"}</Button></div>{!preferences.skipAgent && <div className="mt-3"><CapabilityReadinessPanel projectId={projectId} /></div>}</li>
      <li><strong>Produce an outcome — {requirement?.workComplete ? "tasks are terminal" : requirement?.hasTasks ? "work remains" : "no tasks yet"}</strong><p className="text-sm text-muted-foreground">Use the existing task actions. For the sample, add your one-sentence outcome as a task comment, then mark that task Done. Optional agent runs require their existing approvals and readiness.</p>{requirement && <Link className="underline" href={requirementHref}>Open tasks</Link>}</li>
      <li><strong>Review delivered evidence — {requirement?.reviewed ? "acceptance recorded" : requirement?.hasOutput ? "output available; review remains" : "no available output recorded"}</strong><p className="text-sm text-muted-foreground">Register the comment or other output in the requirement workflow, inspect it, complete delivery with a reason, then record acceptance. Task completion alone does not prove a reviewed outcome.</p>{requirement && <Link className="underline" href={`${requirementHref}#workflow`}>Open evidence and review</Link>}</li>
    </ol>
    <p role="status" className="text-xs text-muted-foreground">Observed {new Date(state.observedAt).toLocaleString()}{query.isFetching ? " · refreshing" : ""}. {requirement?.reviewed ? "A first reviewed outcome is recorded in the current requirement." : "A reviewed outcome has not yet been established for the current requirement."}</p>
    {state.canArchiveSample && <><Button variant="outline" disabled={archive.isPending} onClick={() => setArchiveOpen(true)}>Archive this sample project</Button><ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive this sample project?" description="Only this sample project is archived. Its plan, requirements, tasks and evidence are retained and can be restored through project settings. Other projects are unaffected." confirmLabel="Archive sample" pending={archive.isPending} onConfirm={() => archive.mutate({ id: projectId })} /></>}
  </section>;
}

// Only non-sensitive presentation preferences belong in this external store.
const preferenceFallback = new Map<string, string>();
function readPreferences(key: string) {
  try { return localStorage.getItem(key) ?? preferenceFallback.get(key) ?? "{}"; }
  catch { return preferenceFallback.get(key) ?? "{}"; }
}
function parsePreferences(snapshot: string) {
  try { const value = JSON.parse(snapshot || "{}"); return { hidden: value?.hidden === true, skipAgent: value?.skipAgent === true }; }
  catch { return { hidden: false, skipAgent: false }; }
}
function subscribePreferences(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener("tw:first-success-preferences", notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener("tw:first-success-preferences", notify); };
}
