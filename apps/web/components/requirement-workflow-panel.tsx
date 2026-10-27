"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BASIC_WORKFLOW, requirementWorkflowSchema, type RequirementWorkflow } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RequirementRecoveryPanel } from "@/components/requirement-recovery-panel";
import { WorkflowEditor } from "@/components/workflow-editor";

type Output = { id: string; type: string; summary: string | null; url: string | null; relativePath: string | null; nodeId: string | null; availability: string };
type WorkflowRequirement = {
  id: string; status: string; workflow: unknown; workflowSource: string | null;
  workflowState: unknown; workflowStateRevision: number;
  planRevision?: number; evidenceNeedsReview?: boolean; recoveryAttempts?: number;
  recoveryPolicy?: { retrySafe: boolean; maxAttempts: number; graceMs: number };
  executionRecovery?: Array<{ id: string; runId: string; daemonId: string; phase: string; reason: string; revision: number; deadline: Date | string; workspace: Record<string, unknown> | null }>;
  executionSynchronizations?: Array<{ id: string; runId: string; repositoryId: string; remoteTip: string; planRevision: number; fetchedAt: Date | string }>;
  workflowOutputs?: Output[];
  workflowInputs?: Array<{ id: string; output: Output; taskId: string | null; executionSliceId: string | null }>;
};

export function RequirementWorkflowPanel({ requirement }: { requirement: WorkflowRequirement }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [definition, setDefinition] = useState<RequirementWorkflow>(BASIC_WORKFLOW);
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [outputValue, setOutputValue] = useState("");
  const [inputId, setInputId] = useState("");
  const refresh = () => { void utils.requirement.get.invalidate({ id: requirement.id }); void utils.requirement.recoveryState.invalidate({ id: requirement.id }); };
  const update = trpc.requirement.update.useMutation({ onSuccess: () => { refresh(); setEditing(false); toast.success("Workflow updated"); }, onError: (error) => toast.error(error.message) });
  const advance = trpc.requirement.advanceWorkflowStage.useMutation({ onSuccess: () => { refresh(); setReason(""); setChecks({}); toast.success("Stage updated"); }, onError: (error) => toast.error(error.message) });
  const registerOutput = trpc.requirement.registerWorkflowOutput.useMutation({ onSuccess: () => { refresh(); setOutputValue(""); toast.success("Output registered"); }, onError: (error) => toast.error(error.message) });
  const addInput = trpc.requirement.addWorkflowInput.useMutation({ onSuccess: () => { refresh(); setInputId(""); toast.success("Input dependency registered"); }, onError: (error) => toast.error(error.message) });
  const parsed = requirementWorkflowSchema.safeParse(requirement.workflow);
  const workflow = parsed.success ? parsed.data : null;
  const state = (requirement.workflowState ?? {}) as Record<string, string>;
  const terminal = ["done", "cancelled", "archived"].includes(requirement.status);
  const stages = ["delivery", "acceptance", "integration"] as const;
  const nextStage = stages.find((stage) => !["complete", "skipped"].includes(state[stage] ?? "pending"));
  const canEdit = ["draft", "approved"].includes(requirement.status);
  const canAdvance = workflow && nextStage && !terminal && (workflow[nextStage].mode === "manual" || state[nextStage] === "failed");
  const save = () => {
    const validated = requirementWorkflowSchema.safeParse(definition);
    if (!validated.success) { toast.error("Invalid workflow", { description: validated.error.issues.map((issue) => issue.message).join("; ") }); return; }
    update.mutate({ id: requirement.id, data: { workflow: validated.data } });
  };
  const decide = (decision: "complete" | "changes_requested" | "retry") => {
    if (!nextStage || !reason.trim()) return;
    advance.mutate({ requirementId: requirement.id, data: {
      stage: nextStage, decision, reason: reason.trim(), expectedRevision: requirement.workflowStateRevision,
      checks: (workflow?.acceptance.requiredChecks ?? []).map((name) => ({ name, status: checks[name] ? "passed" : "failed" })),
    } });
  };
  const method = workflow?.delivery.method;
  const registerable = method === "url" || method === "comment" || method === "attachment";

  return <Card>
    <CardHeader><CardTitle>{workflow ? "Delivery, acceptance and integration" : "Legacy Git workflow"}</CardTitle></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p className="text-muted-foreground">Plan revision {requirement.planRevision ?? 0}. Execution input edits stop affected runs. Notification receipt does not confirm that execution has stopped.</p>
      {requirement.evidenceNeedsReview && <p role="alert" className="rounded border border-amber-500 p-3">The plan changed after work completed. Inspect historical evidence against the latest acceptance criteria and record explicit revalidation before delivery.</p>}
      <RequirementRecoveryPanel key={requirement.id} requirementId={requirement.id} />
      {requirement.executionSynchronizations?.slice(0, 3).map(sync => <p key={sync.id} className="break-all text-xs text-muted-foreground">Observed target baseline: {sync.remoteTip} · plan {sync.planRevision} · fetched {new Date(sync.fetchedAt).toISOString()} · run {sync.runId}. The remote branch may advance after this observation.</p>)}


      {!workflow && <p className="text-muted-foreground">This requirement keeps its existing Git delivery flow. Unstarted requirements can migrate to a configurable workflow.</p>}
      {workflow && <>
        <p className="text-muted-foreground">Source: {requirement.workflowSource ?? "explicit"} · {terminal ? "Workflow closed" : `Next action: ${nextStage ?? "complete"}`}</p>
        {stages.map((stage) => <div key={stage} className="rounded-md border p-3">
          <div className="font-medium capitalize">{stage}: {state[stage] ?? "pending"}</div>
          <p className="text-muted-foreground">{workflow[stage].mode === "manual" ? "Human decision" : workflow[stage].mode === "skip" ? "No additional action" : stage === "delivery" ? "Executor" : stage === "acceptance" ? "Reviewer" : "Integrator"}{stage === "delivery" ? ` · ${workflow.delivery.method}` : stage === "integration" ? ` · ${workflow.integration.method}` : ""}</p>
          {workflow[stage].instructions && <p className="mt-1 whitespace-pre-wrap">{workflow[stage].instructions}</p>}
        </div>)}
        {requirement.workflowOutputs?.length ? <div className="space-y-2"><div className="font-medium">Outputs</div>{requirement.workflowOutputs.map((output) => <div key={output.id} className="break-all rounded border p-2"><div>{output.type} · {output.availability}{output.nodeId ? ` · ${output.nodeId}` : ""}</div><div className="text-muted-foreground">{output.summary || (output.type === "url" ? output.url : null) || output.id}</div><div className="text-xs text-muted-foreground">{output.id}</div>{["local", "git_branch", "git_pr", "attachment"].includes(output.type) && <EvidenceMetadata requirementId={requirement.id} outputId={output.id} />}</div>)}</div> : null}
        {requirement.workflowInputs?.length ? <div className="space-y-1"><div className="font-medium">Required inputs</div>{requirement.workflowInputs.map((input) => <p key={input.id} className="break-all text-muted-foreground">{input.output.summary || input.output.id} · {input.output.availability}{input.output.nodeId ? ` · node ${input.output.nodeId}` : ""}</p>)}</div> : null}
        {!terminal && <div className="flex gap-2"><Input aria-label="Required output ID" placeholder="Output ID needed by this requirement" value={inputId} onChange={(event) => setInputId(event.target.value)} /><Button variant="outline" disabled={!inputId.trim() || addInput.isPending} onClick={() => addInput.mutate({ requirementId: requirement.id, data: { outputId: inputId.trim() } })}>Add input</Button></div>}
        {!terminal && !["complete", "skipped"].includes(state.acceptance ?? "pending") && registerable && <div className="flex gap-2"><Input aria-label="Delivery output" placeholder={method === "url" ? "Delivered output URL" : `${method} ID`} value={outputValue} onChange={(event) => setOutputValue(event.target.value)} /><Button variant="outline" disabled={!outputValue.trim() || registerOutput.isPending} onClick={() => registerOutput.mutate({ requirementId: requirement.id, data: { type: method, ...(method === "url" ? { url: outputValue.trim() } : { referenceId: outputValue.trim() }) } })}>Register output</Button></div>}
        {method === "local" && !terminal && <p className="text-muted-foreground">Register a file on its producing machine with <code>tw req output register {requirement.id} --type local --file /path/to/file</code>. The file stays on that node.</p>}
        {canAdvance && <div className="space-y-3">
          <Textarea aria-label="Stage decision reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`Reason for the ${nextStage} decision`} rows={2} />
          {nextStage === "acceptance" && workflow.acceptance.requiredChecks.map((name) => <label key={name} className="flex items-center gap-2"><input type="checkbox" checked={Boolean(checks[name])} onChange={(event) => setChecks({ ...checks, [name]: event.target.checked })} />{name}</label>)}
          <div className="flex flex-wrap gap-2"><Button onClick={() => decide("complete")} disabled={!reason.trim() || advance.isPending}>Complete {nextStage}</Button>{nextStage !== "delivery" && <Button variant="outline" onClick={() => decide("changes_requested")} disabled={!reason.trim() || advance.isPending}>Request changes</Button>}{nextStage && state[nextStage] === "failed" && <Button variant="outline" onClick={() => decide("retry")} disabled={!reason.trim() || advance.isPending}>Retry stage</Button>}</div>
        </div>}
      </>}
      {canEdit && (editing ? <div className="space-y-3"><WorkflowEditor value={definition} onChange={setDefinition} /><div className="flex gap-2"><Button onClick={save} disabled={update.isPending}>Save workflow</Button><Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div></div> : <Button variant="outline" onClick={() => { setDefinition(workflow ?? BASIC_WORKFLOW); setEditing(true); }}>{workflow ? "Edit workflow" : "Configure workflow"}</Button>)}
    </CardContent>
  </Card>;
}

function EvidenceMetadata({ requirementId, outputId }: { requirementId: string; outputId: string }) {
  const [open, setOpen] = useState(false);
  const evidence = trpc.requirement.evidence.useQuery({ requirementId, outputId }, { enabled: open, retry: false });
  return <div className="mt-2 space-y-1"><Button size="sm" variant="outline" onClick={() => setOpen(value => !value)}>{open ? "Hide evidence details" : "Evidence details"}</Button>
    {open && evidence.isLoading && <p>Loading evidence…</p>}
    {open && evidence.error && <p role="alert">Evidence is unavailable or access is denied.</p>}
    {open && evidence.data && <div className="space-y-1 text-xs"><p>Source: {evidence.data.kind} · {evidence.data.availability}</p>
      {evidence.data.kind === "local" && <><p>Size: {evidence.data.sizeBytes} bytes</p><p>SHA-256: {evidence.data.sha256}</p><p>Node read transport is not yet available.</p></>}
      {evidence.data.kind === "git" && <><p>Commit: {evidence.data.headCommit}</p><p>Comparison viewer is not yet available.</p></>}
      {evidence.data.kind === "unsupported" && <p>This output does not have a supported immutable evidence identity.</p>}
    </div>}
  </div>;
}
