"use client";

import { use, useState } from "react";
import Link from "next/link";
import { stagedPlanSchema, planSchema, planRequirementSchema, planTaskSchema, planSliceSchema, type PlanInput } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DependencyDag } from "@/components/dependency-dag";
import { toast } from "sonner";

export default function PlanPage({ params }: { params: Promise<{ id: string; draftId: string }> }) {
  const { id, draftId } = use(params);
  const draft = trpc.plan.getDraft.useQuery({ projectId: id, draftId }, { refetchOnWindowFocus: false });
  const receipt = trpc.plan.getReceipt.useQuery({ projectId: id, draftId }, { enabled: Boolean(draft.error), retry: false });
  return <main className="mx-auto max-w-6xl space-y-4 p-4 md:p-6"><Link href={`/projects/${id}`} className="text-sm underline">Back to project</Link>
    {draft.isLoading && <p>Loading draft…</p>}{draft.error && receipt.isLoading && <p>Checking receipt…</p>}{draft.error && receipt.error && <p role="alert">Draft is unavailable or you do not have access.</p>}
    {receipt.data && <section><h1 className="text-xl font-semibold">Plan applied</h1><ul>{receipt.data.result.refs.requirements.map(ref => <li key={ref.key}><Link className="underline" href={`/projects/${id}/requirements/${ref.id}`}>{ref.title ?? ref.key}</Link> · {ref.existing ? "reused" : "created"}</li>)}</ul></section>}
    {draft.data && <PlanEditor key={draft.data.id} projectId={id} draftId={draftId} initialPlan={planSchema.parse(draft.data.plan)} initialRevision={draft.data.revision} canWrite={draft.data.canWrite} />}
  </main>;
}

function PlanEditor({ projectId, draftId, initialPlan, initialRevision, canWrite }: { projectId: string; draftId: string; initialPlan: PlanInput; initialRevision: number; canWrite: boolean }) {
  const [plan, setPlan] = useState(initialPlan);
  const [revision, setRevision] = useState(initialRevision);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Awaited<ReturnType<typeof validate.mutateAsync>> | null>(null);
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof apply.mutateAsync>> | null>(null);
  const [error, setError] = useState("");
  const [existingRequirement, setExistingRequirement] = useState("");
  const [existingTasks, setExistingTasks] = useState<Record<string, string>>({});
  const utils = trpc.useUtils();
  const save = trpc.plan.updateDraft.useMutation();
  const validate = trpc.plan.validateDraft.useMutation();
  const apply = trpc.plan.applyDraft.useMutation();
  const discard = trpc.plan.discardDraft.useMutation();
  const busy = save.isPending || validate.isPending || apply.isPending || discard.isPending;
  const change = (edit: (value: PlanInput) => void) => { const next = structuredClone(plan); edit(next); setPlan(next); setDirty(true); setReview(null); setError(""); };
  const key = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
  const saveDraft = async () => {
    const checked = stagedPlanSchema.safeParse(plan);
    if (!checked.success) { setError(checked.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    try { const updated = await save.mutateAsync({ draftId, data: { projectId, revision, plan: checked.data } }); setRevision(updated.revision); setDirty(false); setReview(null); setError(""); toast.success("Draft saved"); }
    catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
  };
  const validateDraft = async () => {
    try { const value = await validate.mutateAsync({ projectId, draftId }); if (!value.ok) { setReview(null); setError(value.diagnostic); } else { setReview(value); setError(""); } }
    catch (e) { setReview(null); setError(e instanceof Error ? e.message : "Validation failed"); }
  };
  const applyDraft = async () => {
    const storageKey = `tw-plan-operation:${draftId}:${revision}`;
    const operationKey = localStorage.getItem(storageKey) ?? crypto.randomUUID();
    localStorage.setItem(storageKey, operationKey);
    try { const value = await apply.mutateAsync({ projectId, draftId, revision, operationKey }); setReceipt(value); setError(""); void utils.project.invalidate(); void utils.requirement.invalidate(); void utils.task.invalidate(); }
    catch (e) { setReview(null); setError(e instanceof Error ? e.message : "Apply failed; validate and retry"); }
  };
  const nodes = plan.requirements.flatMap(req => [
    { id: req.key, title: req.title ?? req.existingId ?? req.key, status: "draft", meta: req.existingId ? "Reused requirement" : "New requirement" },
    ...req.tasks.map(task => ({ id: task.key, title: task.title ?? task.existingId ?? task.key, status: "todo", meta: task.existingId ? "Reused task" : "New task" })),
  ]);
  const edges = [
    ...plan.requirementDependencies.map((edge, i) => ({ id: `r-${i}`, source: edge.dependsOn, target: edge.requirement, type: edge.type })),
    ...plan.taskDependencies.map((edge, i) => ({ id: `t-${i}`, source: edge.dependsOn, target: edge.task, type: edge.type })),
    ...plan.requirements.flatMap(req => [...req.dependsOn, ...req.dependencies].map((dep, i) => ({ id: `${req.key}-r-${i}`, source: typeof dep === "string" ? dep : dep.requirement, target: req.key, type: typeof dep === "string" ? "blocks" : dep.type }))),
    ...plan.requirements.flatMap(req => req.tasks.flatMap(task => [...task.dependsOn, ...task.dependencies].map((dep, i) => ({ id: `${task.key}-t-${i}`, source: typeof dep === "string" ? dep : dep.task, target: task.key, type: typeof dep === "string" ? "blocks" : dep.type })))),
  ];
  if (receipt) return <section className="space-y-3"><h1 className="text-xl font-semibold">Plan applied</h1><p>Created work starts as drafts and to-do tasks. Approval is a separate action.</p><ul className="space-y-1">{receipt.result.refs.requirements.map(ref => <li key={ref.key}><Link className="underline" href={`/projects/${projectId}/requirements/${ref.id}`}>{ref.title ?? ref.key}</Link> · {ref.existing ? "reused" : "created"}</li>)}</ul><Link className="underline" href={`/projects/${projectId}`}>Open project</Link></section>;
  return <fieldset disabled={!canWrite} className="space-y-5"><header><h1 className="text-xl font-semibold">Plan draft</h1><p className="text-sm text-muted-foreground">Revision {revision} · {dirty ? "Unsaved changes" : "Saved"}{canWrite ? "" : " · Read only"}. Existing items are references; edits here do not change them.</p></header>
    {error && <p role="alert" className="rounded border border-destructive p-3">{error}. Your edits are retained.</p>}
    <section className="space-y-3"><h2 className="font-semibold">Dependency graph</h2><DependencyDag nodes={nodes} edges={edges} /></section>
    {plan.requirements.map((req, ri) => <section key={req.key} className="space-y-3 rounded border p-4"><div className="flex flex-wrap items-center gap-2"><strong>{req.existingId ? "Reused requirement" : "New requirement"}</strong><code className="text-xs">{req.key}</code><Button size="sm" variant="outline" onClick={() => change(p => { p.requirements.splice(ri, 1); })}>Remove from draft</Button></div>
      <label className="block text-sm">Title<Input disabled={Boolean(req.existingId)} value={req.title ?? ""} onChange={e => change(p => { p.requirements[ri]!.title = e.target.value; })} /></label>
      {req.existingId && <p className="break-all text-xs">Existing ID: {req.existingId}</p>}
      {!req.existingId && <label className="block text-sm">Description<Textarea value={req.description ?? ""} onChange={e => change(p => { p.requirements[ri]!.description = e.target.value; })} /></label>}
      <h3 className="font-medium">Execution slices</h3><ol className="space-y-2">{req.slices.map((slice, si) => <li key={slice.key} className="flex flex-wrap gap-2"><Input className="max-w-sm" aria-label="Slice title" value={slice.title} onChange={e => change(p => { p.requirements[ri]!.slices[si]!.title = e.target.value; })} /><Button size="sm" variant="outline" disabled={si === 0} onClick={() => change(p => { const slices = p.requirements[ri]!.slices; [slices[si - 1], slices[si]] = [slices[si]!, slices[si - 1]!]; slices.forEach((item, i) => { item.orderIndex = i; }); })}>Move up</Button><Button size="sm" variant="outline" onClick={() => change(p => { const requirement = p.requirements[ri]!; requirement.slices.splice(si, 1); for (const task of requirement.tasks) if (task.slice === slice.key) task.slice = undefined; })}>Remove</Button><span className="text-xs text-muted-foreground">{slice.key}</span></li>)}</ol>
      <Button size="sm" variant="outline" onClick={() => change(p => { const slices = p.requirements[ri]!.slices; slices.push(planSliceSchema.parse({ key: key("slice"), title: "New slice", orderIndex: slices.length })); })}>Add slice</Button>
      <h3 className="font-medium">Tasks</h3><ul className="space-y-3">{req.tasks.map((task, ti) => <li key={task.key} className="space-y-2 rounded bg-muted/40 p-3"><div className="flex flex-wrap items-center gap-2"><strong>{task.existingId ? "Reused task" : "New task"}</strong><code className="text-xs">{task.key}</code><Button size="sm" variant="outline" onClick={() => change(p => { p.requirements[ri]!.tasks.splice(ti, 1); })}>Remove from draft</Button></div>
        <label className="block text-sm">Title<Input disabled={Boolean(task.existingId)} value={task.title ?? ""} onChange={e => change(p => { p.requirements[ri]!.tasks[ti]!.title = e.target.value; })} /></label>
        {task.existingId && <p className="break-all text-xs">Existing ID: {task.existingId}</p>}
        {!task.existingId && <label className="block text-sm">Description<Textarea value={task.description ?? ""} onChange={e => change(p => { p.requirements[ri]!.tasks[ti]!.description = e.target.value; })} /></label>}
        <label className="block text-sm">Slice<select className="ml-2 rounded border bg-background p-2" value={task.slice ?? req.slices.find(slice => slice.tasks.includes(task.key) || Boolean(task.existingId && slice.tasks.includes(task.existingId)))?.key ?? ""} onChange={e => change(p => { p.requirements[ri]!.tasks[ti]!.slice = e.target.value || undefined; for (const slice of p.requirements[ri]!.slices) slice.tasks = slice.tasks.filter(ref => ref !== task.key && ref !== task.existingId); })}><option value="">Unassigned</option>{req.slices.map(slice => <option key={slice.key} value={slice.key}>{slice.title}</option>)}</select></label>
      </li>)}</ul><Button size="sm" variant="outline" onClick={() => change(p => { p.requirements[ri]!.tasks.push(planTaskSchema.parse({ key: key("task"), title: "New task" })); })}>Add task</Button>
      {req.existingId && <div className="flex flex-wrap gap-2"><Input className="max-w-sm" aria-label="Existing task ID" placeholder="Existing task ID" value={existingTasks[req.key] ?? ""} onChange={e => setExistingTasks({ ...existingTasks, [req.key]: e.target.value })} /><Button size="sm" variant="outline" disabled={!/^[0-9a-f-]{36}$/i.test(existingTasks[req.key] ?? "")} onClick={() => { change(p => { p.requirements[ri]!.tasks.push(planTaskSchema.parse({ key: key("task"), existingId: existingTasks[req.key] })); }); setExistingTasks({ ...existingTasks, [req.key]: "" }); }}>Reuse task</Button></div>}
    </section>)}
    <Button variant="outline" onClick={() => change(p => { p.requirements.push(planRequirementSchema.parse({ key: key("requirement"), title: "New requirement" })); })}>Add requirement</Button>
    <div className="flex flex-wrap gap-2"><Input className="max-w-sm" aria-label="Existing requirement ID" placeholder="Existing requirement ID" value={existingRequirement} onChange={e => setExistingRequirement(e.target.value)} /><Button variant="outline" disabled={!/^[0-9a-f-]{36}$/i.test(existingRequirement)} onClick={() => { change(p => { p.requirements.push(planRequirementSchema.parse({ key: key("requirement"), existingId: existingRequirement })); }); setExistingRequirement(""); }}>Reuse requirement</Button></div>
    <DependencyEditor plan={plan} change={change} />
    <div className="flex flex-wrap gap-2"><Button onClick={saveDraft} disabled={!dirty || busy}>Save</Button><Button variant="outline" onClick={validateDraft} disabled={dirty || busy}>Validate saved draft</Button><Button variant="outline" onClick={async () => { try { await discard.mutateAsync({ projectId, draftId, revision }); window.location.assign(`/projects/${projectId}`); } catch (e) { setError(e instanceof Error ? e.message : "Discard failed"); } }} disabled={dirty || busy}>Discard</Button></div>
    {review?.ok && review.revision === revision && <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">Review impact</h2><p>Requirements: {review.result.summary.requirements.create} new, {review.result.summary.requirements.reuse} reused. Tasks: {review.result.summary.tasks.create} new, {review.result.summary.tasks.reuse} reused. Slices: {review.result.summary.slices.create}. Dependencies: {review.result.summary.requirementDependencies + review.result.summary.taskDependencies}.</p><p>New requirements remain draft. Adding work to an existing requirement can change its execution state and invalidate active runs.</p>
      <h3 className="font-medium">Requirements and workflow</h3><ul className="list-inside list-disc">{review.result.refs.requirements.map(ref => <li key={ref.key}>{ref.title ?? ref.key} · {ref.existing ? "reuse" : "create"}{review.result.workflows?.find(workflow => workflow.key === ref.key) ? ` · workflow source: ${review.result.workflows.find(workflow => workflow.key === ref.key)!.source}` : ""}</li>)}</ul>
      <h3 className="font-medium">Tasks and slices</h3><ul className="list-inside list-disc">{review.result.refs.tasks.map(ref => <li key={ref.key}>{ref.title ?? ref.key} · {ref.existing ? "reuse" : "create"}</li>)}{plan.requirements.flatMap(req => req.slices.map(slice => <li key={slice.key}>{slice.title} · slice order {slice.orderIndex ?? "default"}</li>))}</ul>
      <p>Documents: {review.result.summary.documents.create} new, {review.result.summary.documents.reuse} reused. Links: {review.result.summary.documentLinks + review.result.summary.documentRequirementLinks + review.result.summary.documentTaskLinks}. Comments: {review.result.summary.taskComments}; notes: {review.result.summary.taskNotes}.</p>{review.result.warnings.map(warning => <p key={warning} role="alert">{warning}</p>)}<Button disabled={busy || dirty} onClick={applyDraft}>Apply reviewed plan</Button></section>}
  </fieldset>;
}

function DependencyEditor({ plan, change }: { plan: PlanInput; change: (edit: (value: PlanInput) => void) => void }) {
  const [kind, setKind] = useState<"task" | "requirement">("task");
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [type, setType] = useState<"blocks" | "related">("blocks");
  const options = kind === "task" ? plan.requirements.flatMap(req => req.tasks.map(task => ({ key: task.key, title: task.title ?? task.key }))) : plan.requirements.map(req => ({ key: req.key, title: req.title ?? req.key }));
  return <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">Dependency list</h2><p className="text-sm text-muted-foreground">The first item depends on the second. Related links do not gate scheduling.</p>
    <ul>{plan.requirements.flatMap((req, ri) => (["dependsOn", "dependencies"] as const).flatMap(field => req[field].map((edge, index) => <li key={`${req.key}-${field}-${index}`}>{req.key} → {typeof edge === "string" ? edge : edge.requirement} ({typeof edge === "string" ? "blocks" : edge.type}) <Button size="sm" variant="ghost" onClick={() => change(p => { p.requirements[ri]![field].splice(index, 1); })}>Remove</Button></li>)))}
      {plan.requirements.flatMap((req, ri) => req.tasks.flatMap((task, ti) => (["dependsOn", "dependencies"] as const).flatMap(field => task[field].map((edge, index) => <li key={`${task.key}-${field}-${index}`}>{task.key} → {typeof edge === "string" ? edge : edge.task} ({typeof edge === "string" ? "blocks" : edge.type}) <Button size="sm" variant="ghost" onClick={() => change(p => { p.requirements[ri]!.tasks[ti]![field].splice(index, 1); })}>Remove</Button></li>))))}
      {plan.requirementDependencies.map((edge, i) => <li key={`r-${i}`}>{edge.requirement} → {edge.dependsOn} ({edge.type}) <Button size="sm" variant="ghost" onClick={() => change(p => { p.requirementDependencies.splice(i, 1); })}>Remove</Button></li>)}{plan.taskDependencies.map((edge, i) => <li key={`t-${i}`}>{edge.task} → {edge.dependsOn} ({edge.type}) <Button size="sm" variant="ghost" onClick={() => change(p => { p.taskDependencies.splice(i, 1); })}>Remove</Button></li>)}</ul>
    <div className="flex flex-wrap gap-2"><select aria-label="Dependency kind" className="rounded border bg-background p-2" value={kind} onChange={e => { setKind(e.target.value as typeof kind); setFrom(""); setTo(""); }}><option value="task">Task</option><option value="requirement">Requirement</option></select><select aria-label="Dependent item" className="rounded border bg-background p-2" value={from} onChange={e => setFrom(e.target.value)}><option value="">Dependent</option>{options.map(option => <option key={option.key} value={option.key}>{option.title}</option>)}</select><select aria-label="Prerequisite item" className="rounded border bg-background p-2" value={to} onChange={e => setTo(e.target.value)}><option value="">Prerequisite</option>{options.map(option => <option key={option.key} value={option.key}>{option.title}</option>)}</select><select aria-label="Dependency type" className="rounded border bg-background p-2" value={type} onChange={e => setType(e.target.value as typeof type)}><option value="blocks">Blocks</option><option value="related">Related</option></select><Button variant="outline" disabled={!from || !to || from === to} onClick={() => change(p => { if (kind === "task") p.taskDependencies.push({ task: from, dependsOn: to, type }); else p.requirementDependencies.push({ requirement: from, dependsOn: to, type }); })}>Add dependency</Button></div>
  </section>;
}
