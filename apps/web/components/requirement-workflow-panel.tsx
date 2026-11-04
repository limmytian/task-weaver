"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BASIC_WORKFLOW, requirementWorkflowSchema, evidencePreviewKind, type RequirementWorkflow } from "@task-weaver/contracts";
import { readEvidencePreview } from "@/lib/evidence-preview-transfer";
import { recordedReviewChecks, type ReviewCheckStatus } from "@/lib/review-checks";
import { gitDiffLines } from "@/lib/git-diff-lines";
import { highlightGitDiffLine } from "@/lib/git-diff-highlight";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceTablePreview } from "@/components/evidence-table-preview";
import { TextAttachmentPreview } from "@/components/text-attachment-preview";
import { PdfAttachmentPreview } from "@/components/pdf-attachment-preview";
import { RequirementRecoveryPanel } from "@/components/requirement-recovery-panel";
import { WorkflowEditor } from "@/components/workflow-editor";

type Output = { workflowRevision?: number; planRevision?: number; verifiedAt?: Date | string | null; id: string; type: string; summary: string | null; url: string | null; relativePath: string | null; nodeId: string | null; availability: string };
type WorkflowRequirement = {
  id: string; projectId?: string; tasks?: Array<{ status: string }>; status: string; workflow: unknown; workflowSource: string | null;
  workflowState: unknown; workflowRevision?: number; workflowStateRevision: number;
  planRevision?: number; evidenceNeedsReview?: boolean; recoveryAttempts?: number;
  recoveryPolicy?: { retrySafe: boolean; maxAttempts: number; graceMs: number };
  executionRecovery?: Array<{ id: string; runId: string; daemonId: string; phase: string; reason: string; revision: number; deadline: Date | string; workspace: Record<string, unknown> | null }>;
  executionSynchronizations?: Array<{ id: string; runId: string; repositoryId: string; remoteTip: string; planRevision: number; fetchedAt: Date | string }>;
  workflowOutputs?: Output[];
  workflowInputs?: Array<{ id: string; output: Output; taskId: string | null; executionSliceId: string | null }>;
};

export function RequirementWorkflowPanel({ requirement }: { requirement: WorkflowRequirement }) {
  const utils = trpc.useUtils();
  const permissions = trpc.plan.capabilities.useQuery({ projectId: requirement.projectId ?? "" }, { enabled: Boolean(requirement.projectId), retry: false });
  const canWrite = Boolean(permissions.data?.canWrite) && !permissions.error;
  const openTasks = requirement.tasks?.filter(task => !["done", "cancelled"].includes(task.status)).length;
  const [selectedStage, setSelectedStage] = useState<"delivery" | "acceptance" | "integration" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [definition, setDefinition] = useState<RequirementWorkflow>(BASIC_WORKFLOW);
  const [reason, setReason] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const [checks, setChecks] = useState<Record<string, ReviewCheckStatus | undefined>>({});
  const [outputValue, setOutputValue] = useState("");
  const refresh = () => { void utils.attention.list.invalidate(); void utils.requirement.get.invalidate({ id: requirement.id }); void utils.requirement.recoveryState.invalidate({ id: requirement.id }); };
  const update = trpc.requirement.update.useMutation({ onSuccess: () => { refresh(); setEditing(false); toast.success("Workflow updated"); }, onError: (error) => toast.error(error.message) });
  const advance = trpc.requirement.advanceWorkflowStage.useMutation({ onSuccess: () => { refresh(); setReason(""); setReferences([]); setChecks({}); toast.success("Stage updated"); }, onError: (error) => toast.error(error.message) });
  const registerOutput = trpc.requirement.registerWorkflowOutput.useMutation({ onSuccess: () => { refresh(); setOutputValue(""); toast.success("Output registered"); }, onError: (error) => toast.error(error.message) });
  const parsed = requirementWorkflowSchema.safeParse(requirement.workflow);
  const workflow = parsed.success ? parsed.data : null;
  const state = (requirement.workflowState ?? {}) as Record<string, string>;
  const terminal = ["done", "cancelled", "archived"].includes(requirement.status);
  const stages = ["delivery", "acceptance", "integration"] as const;
  const nextStage = state.acceptance === "failed" && state.delivery === "complete" ? "delivery" : stages.find((stage) => !["complete", "skipped"].includes(state[stage] ?? "pending"));
  const viewedStage = selectedStage ?? nextStage ?? "integration";
  const canEdit = canWrite && ["draft", "approved"].includes(requirement.status);
  const canAdvance = canWrite && workflow && nextStage && !terminal && requirement.status !== "draft" && !requirement.evidenceNeedsReview && (nextStage !== "delivery" || openTasks === 0) && (workflow[nextStage].mode === "manual" || state[nextStage] === "failed");
  const save = () => {
    const validated = requirementWorkflowSchema.safeParse(definition);
    if (!validated.success) { toast.error("Invalid workflow", { description: validated.error.issues.map((issue) => issue.message).join("; ") }); return; }
    update.mutate({ id: requirement.id, data: { workflow: validated.data } });
  };
  const decisionText = references.length ? `${reason.trim()}\n\nReferences:\n${references.map(reference => `- ${reference}`).join("\n")}` : reason.trim();
  const decide = (decision: "complete" | "changes_requested" | "retry") => {
    if (!nextStage || !reason.trim() || decisionText.length > 4000) return;
    advance.mutate({ requirementId: requirement.id, data: {
      stage: nextStage, decision, reason: decisionText, expectedRevision: requirement.workflowStateRevision,
      checks: recordedReviewChecks(workflow?.acceptance.requiredChecks ?? [], checks),
    } });
  };
  const method = workflow?.delivery.method;
  const isHistorical = (output: Output) => output.availability === "retired" || (output.workflowRevision !== undefined && requirement.workflowRevision !== undefined && output.workflowRevision !== requirement.workflowRevision);
  const outputs = (requirement.workflowOutputs ?? []).filter(output => showHistory || !isHistorical(output));
  const stageFailed = Boolean(nextStage && state[nextStage] === "failed");
  const checksPassed = nextStage !== "acceptance" || (workflow?.acceptance.requiredChecks ?? []).every(name => checks[name] === "passed");
  const registerable = method === "url" || method === "comment" || method === "attachment";

  return <Card>
    <CardHeader><CardTitle>{workflow ? "Delivery" : "Legacy Git workflow"}</CardTitle></CardHeader>
    <CardContent className="space-y-4 text-sm">
      {!workflow && <p className="text-muted-foreground">This requirement keeps its existing Git delivery flow. Unstarted requirements can migrate to a configurable workflow.</p>}
      {workflow && <>
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="font-medium">{terminal ? `Requirement ${requirement.status}` : requirement.status === "draft" ? "Plan awaiting approval" : requirement.evidenceNeedsReview ? "Delivery needs another review" : openTasks ? `${openTasks} ${openTasks === 1 ? "task" : "tasks"} remaining` : nextStage ? ({ delivery: "Ready for delivery", acceptance: "Ready for review", integration: "Ready to integrate" }[nextStage]) : "Delivery complete"}</p>
            <p className="mt-1 text-muted-foreground">{terminal ? "This requirement is closed." : requirement.status === "draft" ? "Approve the plan to begin work." : requirement.evidenceNeedsReview ? "The plan changed. Review the delivery against the latest requirements." : openTasks ? "Finish the remaining tasks before delivery." : nextStage === "delivery" ? "Prepare the work for review." : nextStage === "acceptance" ? "Review the delivered work and record your decision." : nextStage === "integration" ? "Complete integration to finish this requirement." : "All configured steps are complete."}</p></div>
            {!canWrite && <span className="text-xs text-muted-foreground">Read only</span>}
          </div>
          <ol aria-label="Delivery progress" className="mt-4 grid grid-cols-3 gap-2">{stages.map((stage, index) => {
            const status = state[stage] ?? "pending";
            const done = ["complete", "skipped"].includes(status);
            const active = nextStage === stage && !terminal;
            return <li key={stage} className="min-w-0"><button type="button" aria-pressed={viewedStage === stage} onClick={() => setSelectedStage(stage)} className={`h-full w-full rounded-md border px-2 py-2 text-left hover:bg-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${viewedStage === stage ? "border-primary bg-background" : "border-transparent"}`}><div className="flex items-center gap-2"><span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-primary text-primary-foreground" : active ? "border border-primary text-primary" : "bg-muted text-muted-foreground"}`}>{done ? "✓" : index + 1}</span><span className="break-words font-medium capitalize">{stage === "acceptance" ? "Review" : stage}</span></div><p className="mt-1 text-xs text-muted-foreground sm:pl-8">{status === "failed" ? "Needs attention" : status === "skipped" ? "Skipped" : done ? "Done" : active ? "Current step" : "Upcoming"}</p></button></li>;
          })}</ol>
        </div>
        <section aria-label={`${viewedStage === "acceptance" ? "Review" : viewedStage} stage details`} className="space-y-1 rounded-md border p-3"><h3 className="font-medium capitalize">{viewedStage === "acceptance" ? "Review" : viewedStage}</h3><p className="text-muted-foreground">Status: {state[viewedStage] ?? "pending"} · {workflow[viewedStage].mode === "manual" ? "Human decision" : workflow[viewedStage].mode === "skip" ? "Skipped by workflow" : "Automatic"}{viewedStage === "delivery" ? ` · ${workflow.delivery.method.replaceAll("_", " ")}` : viewedStage === "integration" ? ` · ${workflow.integration.method.replaceAll("_", " ")}` : ""}</p>{workflow[viewedStage].instructions && <p className="whitespace-pre-wrap">{workflow[viewedStage].instructions}</p>}{viewedStage === "acceptance" && <p className="text-muted-foreground">Review the delivered work and record a decision when review is active.</p>}{viewedStage === "integration" && <p className="text-muted-foreground">Integration follows the configured workflow after review.</p>}</section>
        {viewedStage !== "integration" && <>
        {requirement.workflowOutputs?.length ? <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Delivered work</h3><Button size="sm" variant="ghost" onClick={() => setShowHistory(value => !value)}>{showHistory ? "Current only" : "Show history"}</Button></div>{outputs.length === 0 && <p>No current evidence. Historical records remain available.</p>}{outputs.map((output) => <div key={output.id} className="break-all rounded border p-2"><div className="font-medium">{output.summary || (output.type === "url" ? output.url : null) || `${output.type.replaceAll("_", " ")} delivery`}</div><p className="text-xs text-muted-foreground">{output.type.replaceAll("_", " ")} · {output.availability}{isHistorical(output) ? " · historical" : ""}{requirement.evidenceNeedsReview ? " · review required" : ""}</p>{output.type === "url" && <p className="text-xs">External link supplied by the author; contents are not verified.</p>}<details><summary className="cursor-pointer text-xs">Technical identity</summary><p className="select-all text-xs">{output.id}{output.nodeId ? ` · node ${output.nodeId}` : ""}</p></details>{["local", "git_branch", "git_pr", "attachment"].includes(output.type) && <EvidenceMetadata requirementId={requirement.id} outputId={output.id} onReviewFeedback={canAdvance && nextStage === "acceptance" ? (reference) => { setReferences(current => current.includes(reference) ? current : [...current, reference]); setSelectedStage("acceptance"); requestAnimationFrame(() => { decisionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); decisionRef.current?.focus(); }); } : undefined} />}</div>)}</div> : null}
        {requirement.workflowInputs?.length ? <div className="space-y-1"><div className="font-medium">Required inputs</div>{requirement.workflowInputs.map((input) => <p key={input.id} className="break-all text-muted-foreground">{input.output.summary || input.output.id} · {input.output.availability}{input.output.nodeId ? ` · node ${input.output.nodeId}` : ""}</p>)}</div> : null}

        {viewedStage === "delivery" && canWrite && !terminal && !["complete", "skipped"].includes(state.acceptance ?? "pending") && registerable && <div className="flex gap-2"><Input aria-label="Delivery output" placeholder={method === "url" ? "Delivered output URL" : `${method} ID`} value={outputValue} onChange={(event) => setOutputValue(event.target.value)} /><Button variant="outline" disabled={!outputValue.trim() || registerOutput.isPending} onClick={() => registerOutput.mutate({ requirementId: requirement.id, data: { type: method, ...(method === "url" ? { url: outputValue.trim() } : { referenceId: outputValue.trim() }) } })}>Register output</Button></div>}
        {viewedStage === "delivery" && method === "local" && !terminal && <p className="text-muted-foreground">Register a file on its producing machine with <code>tw req output register {requirement.id} --type local --file /path/to/file</code>. The file stays on that node.</p>}
        </>}
        {viewedStage === nextStage && !terminal && nextStage && workflow[nextStage].mode === "automatic" && !stageFailed && <p role="status" className="text-muted-foreground">{nextStage === "delivery" && workflow.delivery.method === "none" ? "Automatic delivery reconciles after the final task completes. Existing completed records can be advanced through the guarded workflow command." : `Waiting for the ${nextStage === "delivery" ? "executor to register delivery evidence" : nextStage === "acceptance" ? "reviewer to evaluate delivery" : "integrator to complete integration"}.`}</p>}

      </>}
      <RequirementRecoveryPanel key={requirement.id} requirementId={requirement.id}>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><p>Plan revision {requirement.planRevision ?? 0}. Execution input edits stop affected runs. Notification receipt does not confirm that execution has stopped.</p>{requirement.executionSynchronizations?.slice(0, 3).map(sync => <p key={sync.id} className="break-all">Observed target baseline: {sync.remoteTip} · plan {sync.planRevision} · fetched {new Date(sync.fetchedAt).toISOString()} · run {sync.runId}. The remote branch may advance after this observation.</p>)}</details>
      </RequirementRecoveryPanel>
      {canEdit && (editing ? <div className="space-y-3"><WorkflowEditor value={definition} onChange={setDefinition} /><div className="flex gap-2"><Button onClick={save} disabled={update.isPending}>Save workflow</Button><Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div></div> : <Button variant="outline" onClick={() => { setDefinition(workflow ?? BASIC_WORKFLOW); setEditing(true); }}>{workflow ? "Edit workflow" : "Configure workflow"}</Button>)}
      {workflow && <>
        {viewedStage === nextStage && advance.error && <div role="alert" className="rounded border border-destructive p-3"><p>{advance.error.message}</p><Button size="sm" variant="outline" onClick={refresh}>Refresh current state</Button><p>Review the refreshed state before retrying the decision.</p></div>}
        {viewedStage === nextStage && canAdvance && <div className="space-y-3">
          {references.length > 0 && <div className="space-y-1"><p className="font-medium">References in this decision</p>{references.map(reference => <div key={reference} className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all text-muted-foreground">{reference}</span><Button type="button" size="xs" variant="ghost" aria-label={`Remove reference ${reference}`} onClick={() => setReferences(current => current.filter(item => item !== reference))}>Remove</Button></div>)}</div>}<Textarea ref={decisionRef} aria-label="Stage decision reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`Reason for the ${nextStage} decision`} rows={2} />
          {nextStage === "acceptance" && workflow.acceptance.requiredChecks.map((name) => <label key={name} className="flex flex-wrap items-center gap-2">{name}<select className="rounded border bg-background p-1" value={checks[name] ?? ""} onChange={(event) => setChecks({ ...checks, [name]: (event.target.value || undefined) as ReviewCheckStatus | undefined })}><option value="">Not recorded</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>)}
          {decisionText.length > 4000 && <p role="alert" className="text-destructive">The decision and references exceed 4,000 characters. Shorten the reason or remove references.</p>}<p className="text-muted-foreground">Record a reason before submitting.{!checksPassed ? " All required checks must pass before acceptance." : ""}</p><div className="flex flex-wrap gap-2">{!stageFailed && <Button onClick={() => decide("complete")} disabled={!reason.trim() || decisionText.length > 4000 || advance.isPending || !checksPassed}>{advance.isPending ? "Saving decision…" : nextStage === "acceptance" ? "Accept delivery" : nextStage === "integration" ? "Confirm integration" : "Confirm delivery"}</Button>}{nextStage !== "delivery" && <Button variant="outline" onClick={() => decide("changes_requested")} disabled={!reason.trim() || decisionText.length > 4000 || advance.isPending}>Request changes</Button>}{nextStage && state[nextStage] === "failed" && <Button variant="outline" onClick={() => decide("retry")} disabled={!reason.trim() || decisionText.length > 4000 || advance.isPending}>Retry stage</Button>}</div>
        </div>}
      </>}
    </CardContent>
  </Card>;
}

function EvidenceMetadata({ requirementId, outputId, onReviewFeedback }: { requirementId: string; outputId: string; onReviewFeedback?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("");
  const [controller, setController] = useState<AbortController | null>(null);
  const [localPreview, setLocalPreview] = useState<{ url: string; kind: string; filename: string; truncated: boolean } | null>(null);
  const activeDownload = useRef<AbortController | null>(null);
  useEffect(() => () => activeDownload.current?.abort(), []);
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview.url); }, [localPreview]);
  const evidence = trpc.requirement.evidence.useQuery({ requirementId, outputId }, { enabled: open, retry: false });
  const capabilities = trpc.plan.capabilities.useQuery({ projectId: evidence.data?.projectId ?? '' }, { enabled: open && !evidence.error && Boolean(evidence.data?.projectId), retry: false });
  useEffect(() => { if (evidence.error) activeDownload.current?.abort(); }, [evidence.error]);
  const transfer = async (purpose: 'preview' | 'download' | 'promotion') => {
    const abort = new AbortController(); activeDownload.current = abort; setController(abort); let requestId: string | undefined;
    try {
      const csrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      if (!csrf.ok) throw new Error('Authentication unavailable');
      const token = (await csrf.json()).csrfToken as string;
      const post = (path: string, data: unknown) => fetch(`/api/evidence/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(data), signal: abort.signal });
      setState('Requesting evidence from the producing node…');
      const opened = await post('open', { requirementId, outputId, purpose });
      if (!opened.ok) throw new Error('Evidence producer is unavailable or access is denied');
      requestId = (await opened.json()).requestId;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await fetch(`/api/evidence/${requestId}/status`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error('Evidence request expired or access ended');
        const status = await response.json() as { state: string; failure: string | null };
        if (status.state === 'failed') throw new Error(`Evidence is ${status.failure ?? 'unavailable'}`);
        if (status.state === 'verified') {
          if (purpose === 'promotion') {
            setState('Saving verified evidence as an attachment…');
            const result = await post(`${requestId}/promote`, {});
            if (!result.ok) throw new Error('Evidence promotion failed');
            requestId = undefined; await evidence.refetch(); setState('Verified evidence saved as an attachment.'); return;
          }
          if (purpose === 'preview' && evidence.data?.kind === 'local') {
            const kind = evidencePreviewKind(evidence.data.mimeType, evidence.data.sizeBytes);
            if (kind === 'download') throw new Error('Preview is unavailable for this file');
            setState('Reading a verified preview…');
            const result = await fetch(`/api/evidence/${requestId}/content`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
            if (!result.ok || !result.body) throw new Error('Evidence preview failed');
            const limit = ['text', 'csv', 'tsv'].includes(kind) ? 256 * 1024 : 10 * 1024 * 1024;
            const { parts, truncated } = await readEvidencePreview(result, evidence.data.sizeBytes, limit);
            requestId = undefined;
            const url = URL.createObjectURL(new Blob(parts, { type: evidence.data.mimeType }));
            setLocalPreview({ url, kind, filename: evidence.data.originalFilename, truncated });
            setState('Verified preview ready.'); return;
          }
          setState('Downloading verified bytes…');
          const result = await fetch(`/api/evidence/${requestId}/content`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
          if (!result.ok) throw new Error('Evidence download failed');
          const blob = await result.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'evidence.bin'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          requestId = undefined; setState('Verified download completed.'); return;
        }
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 500); abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(abort.signal.reason); }, { once: true }); });
      }
      throw new Error('Evidence request timed out');
    } catch (error) { setState(abort.signal.aborted ? 'Evidence request cancelled.' : error instanceof Error ? error.message : 'Evidence request failed'); }
    finally {
      if (requestId) {
        try { const csrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' }); const token = (await csrf.json()).csrfToken; await fetch(`/api/evidence/${requestId}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: '{}' }); } catch { /* The request expires automatically. */ }
      }
      activeDownload.current = null; setController(null);
    }
  };
  return <div className="mt-2 space-y-1"><Button size="sm" variant="outline" onClick={() => setOpen(value => !value)}>{open ? "Hide delivery" : "View delivery"}</Button>
    {open && evidence.isLoading && <p>Loading evidence…</p>}
    {open && evidence.error && <div role="alert"><p>Evidence is unavailable or access is denied.</p><Button size="sm" variant="outline" disabled={evidence.isFetching} onClick={() => void evidence.refetch()}>Retry</Button></div>}
    {open && !evidence.error && evidence.data && <div className="space-y-1 text-xs"><p>Source: {evidence.data.kind} · {evidence.data.availability}</p>
      {evidence.data.kind === "local" && evidence.data.availability !== "retired" && <><p>{evidence.data.originalFilename} · {evidence.data.sizeBytes} bytes</p><p>SHA-256: {evidence.data.sha256}</p><p>Preview transfers and verifies the entire file from its node before displaying a bounded sample. A connected compatible producer and enabled evidence service are required.</p><div className="flex flex-wrap gap-2">{evidencePreviewKind(evidence.data.mimeType, evidence.data.sizeBytes) !== 'download' && <Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('preview'); }}>Preview</Button>}<Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('download'); }}>Download original</Button>{!capabilities.error && capabilities.data?.canWrite && <Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('promotion'); }}>Save as attachment</Button>}{controller && <Button size="sm" variant="ghost" onClick={() => controller.abort()}>Cancel request</Button>}</div>{localPreview && <LocalEvidencePreview preview={localPreview} />}</>}
      {evidence.data.kind === "attachment" && evidence.data.availability !== "retired" && <PinnedAttachmentEvidence file={evidence.data} />}
      {evidence.data.availability === "retired" && <p>This output has been retired.</p>}
      {evidence.data.kind === "git" && <><p>{evidence.data.repositoryName} · {evidence.data.branch ?? "delivered commit"} → {evidence.data.baseBranch}</p>{!evidence.data.gitBaseline && <p>Historical delivery baseline was not captured. Current-target comparisons may be empty after integration.</p>}{evidence.data.commitUrl && <a className="underline" href={evidence.data.commitUrl} target="_blank" rel="noopener noreferrer">Open delivered commit on the forge</a>}<GitEvidence requirementId={requirementId} outputId={outputId} headCommit={evidence.data.headCommit} hasHistoricalBaseline={Boolean(evidence.data.gitBaseline)} onReviewFeedback={onReviewFeedback} /></>}
      {evidence.data.kind === "unsupported" && <p>This output does not have a supported immutable evidence identity.</p>}
      {state && <p role="status">{state}</p>}
    </div>}
  </div>;
}

function LocalEvidencePreview({ preview }: { preview: { url: string; kind: string; filename: string; truncated: boolean } }) {
  return <div className="space-y-2">{preview.truncated && <p>Preview is truncated; download the original for the complete file.</p>}
    {preview.kind === 'text' && <TextAttachmentPreview src={preview.url} filename={preview.filename} maximumBytes={256 * 1024} sampled={preview.truncated} />}
    {(preview.kind === 'csv' || preview.kind === 'tsv') && <EvidenceTablePreview src={preview.url} filename={preview.filename} sizeBytes={preview.truncated ? 256 * 1024 + 1 : 0} delimiter={preview.kind === 'csv' ? ',' : '\t'} />}
    {preview.kind === 'pdf' && <PdfAttachmentPreview src={preview.url} filename={preview.filename} />}
    {preview.kind === 'audio' && <audio controls preload="metadata" src={preview.url}>Audio preview is not supported by this browser.</audio>}
    {preview.kind === 'video' && <video controls preload="metadata" className="max-h-96 max-w-full" src={preview.url}>Video preview is not supported by this browser.</video>}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {preview.kind === 'image' && <img src={preview.url} alt={preview.filename} className="max-h-96 max-w-full object-contain" />}
  </div>;
}

function GitEvidence({ requirementId, outputId, headCommit, hasHistoricalBaseline, onReviewFeedback }: { requirementId: string; outputId: string; headCommit: string; hasHistoricalBaseline: boolean; onReviewFeedback?: (path: string) => void }) {
  const comparison = trpc.requirement.compareGitEvidence.useMutation();
  const commit = trpc.requirement.gitEvidenceCommit.useMutation();
  const [mode, setMode] = useState<"historical" | "current">(hasHistoricalBaseline ? "historical" : "current");
  const [selected, setSelected] = useState<number | null>(null);
  const selectedIndex = selected ?? (comparison.data?.files.length ? Math.max(0, comparison.data.files.findIndex(file => file.patchState === "available")) : null);
  const selectedFile = selectedIndex === null ? undefined : comparison.data?.files[selectedIndex];
  const file = trpc.requirement.gitEvidenceFile.useQuery({ requirementId, outputId, comparisonId: comparison.data?.comparisonId ?? "", path: selectedFile?.path ?? "" }, { enabled: Boolean(comparison.data?.comparisonId && selectedFile), retry: false });
  return <div className="space-y-2"><details className="text-muted-foreground"><summary className="cursor-pointer">Comparison settings</summary><p className="break-all">Head commit: {headCommit}</p><label>Compare <select className="rounded border bg-background p-1" value={mode} onChange={event => { setMode(event.target.value as "historical" | "current"); comparison.reset(); }}><option value="historical" disabled={!hasHistoricalBaseline}>Historical delivery baseline{hasHistoricalBaseline ? "" : " (unavailable)"}</option><option value="current">Current target branch</option></select></label></details><Button size="sm" variant="outline" aria-expanded={Boolean(comparison.data)} disabled={comparison.isPending} onClick={() => { setSelected(null); if (comparison.data) comparison.reset(); else comparison.mutate({ requirementId, outputId, mode }); }}>{comparison.data ? "Hide code changes" : "View code changes"}</Button>
    <Button size="sm" variant="ghost" disabled={commit.isPending} onClick={() => commit.mutate({ requirementId, outputId })}>View commit</Button>
    {commit.isPending && <p role="status">Loading commit…</p>}{commit.error && <p role="alert">Commit preview is unavailable. Check your access or the trusted forge connection and retry.</p>}
    {!commit.error && commit.data && <details open><summary>Delivered commit · {commit.data.files.length} files</summary>{commit.data.needsParent ? <div><p>This is a merge commit. Choose a parent explicitly.</p>{commit.data.parents.map(parent => <Button key={parent} size="sm" variant="outline" onClick={() => commit.mutate({ requirementId, outputId, parent })}>Parent {parent.slice(0, 12)}</Button>)}</div> : <><p>{commit.data.parent ? `Compared with parent ${commit.data.parent.slice(0, 12)}` : "Root commit compared with the empty tree"}</p>{commit.data.files.length === 0 && <p>No changed files.</p>}{commit.data.truncated && <p role="status">This bounded preview omits some content.</p>}{commit.data.files.map(entry => <details key={entry.path}><summary className="cursor-pointer break-all">{entry.status}: {entry.path}</summary>{entry.patchState === "available" ? <GitPatch path={entry.path} patch={entry.patch ?? ""} /> : <p>Patch {entry.patchState}; the forge may omit binary content.</p>}</details>)}</>}</details>}
    {comparison.isPending && <p>Opening comparison…</p>}{comparison.error && <p role="alert">{comparison.error.message}</p>}
    {!comparison.error && comparison.data && <><p className="font-medium">{comparison.data.files.length} changed files</p>{!onReviewFeedback && <p className="text-muted-foreground">Review feedback is unavailable in the current workflow state. It requires write access and an active manual review step.</p>}<details className="text-muted-foreground"><summary className="cursor-pointer">Comparison details</summary><p className="break-all">Base: {comparison.data.baseCommit}</p><p className="break-all">Merge base: {comparison.data.comparisonCommit}</p><p>Comparison mode: merge base to delivered head</p></details>{comparison.data.files.length === 0 && <p role="status">No changed files.{comparison.data.comparisonCommit === headCommit ? " The delivered head is already contained in this target baseline." : " The compared trees have no displayable changes."}</p>}{comparison.data.truncated && <p role="status">The comparison exceeds the display limit; some changes are omitted.</p>}
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><ul aria-label="Changed files" className="max-h-48 min-w-0 space-y-1 overflow-auto rounded-md border p-1 lg:max-h-96">{comparison.data.files.map((entry, index) => <li key={`${entry.path}-${index}`}><Button size="sm" variant={selectedIndex === index ? "secondary" : "ghost"} className="h-auto w-full min-w-0 items-start justify-start whitespace-normal break-all py-2 text-left leading-5 md:h-auto" aria-pressed={selectedIndex === index} onClick={() => setSelected(index)}>{entry.status}: {entry.previousPath ? `${entry.previousPath} → ` : ""}{entry.path}</Button></li>)}</ul><div className="min-w-0 overflow-hidden">{file.isFetching && <p>Loading file…</p>}{file.error && <div role="alert"><p>File is unavailable or access is denied.</p><Button size="sm" variant="outline" onClick={() => void file.refetch()}>Retry file</Button></div>}{!file.isFetching && !file.error && file.data && <><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all font-medium">{file.data.path}</p><Button size="sm" variant="outline" disabled={!onReviewFeedback} onClick={() => onReviewFeedback?.(`${file.data.path} @ ${headCommit}`)}>Refer file in decision</Button></div>{file.data.patchState === "available" ? <GitPatch path={file.data.path} patch={file.data.patch ?? ""} onReference={onReviewFeedback ? (side, line) => onReviewFeedback(`${file.data.path}:${line} (${side} side, delivered commit ${headCommit}; comparison base ${comparison.data!.comparisonCommit})`) : undefined} /> : <p>Diff unavailable for this file ({file.data.patchState}).</p>}</>}</div></div>
    </>}
  </div>;
}

function GitPatch({ path, patch, onReference }: { path: string; patch: string; onReference?: (side: "old" | "new", line: number) => void }) {
  const lines = gitDiffLines(patch);
  return <><pre className="max-h-96 max-w-full overflow-auto whitespace-pre text-xs"><code className="block w-max min-w-full">{lines.slice(0, 2000).map(({ text: line, side, line: lineNumber }, index) => <span className={`block ${line.startsWith("+") ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-200" : line.startsWith("-") ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200" : line.startsWith("@@") ? "text-blue-700 dark:text-blue-400" : ""}`} key={index}>{onReference && side && lineNumber !== undefined && <button type="button" className="sticky left-0 mr-1 inline-block bg-background px-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2" aria-label={`Refer ${side} line ${lineNumber} in decision`} onClick={() => onReference(side, lineNumber)}>+</button>}{line ? highlightGitDiffLine(path, line).map((span, i) => <span className={span.className} key={i}>{span.text}</span>) : " "}</span>)}</code></pre>{lines.length > 2000 && <p role="status">Diff display is limited to the first 2,000 lines.</p>}</>;
}

function PinnedAttachmentEvidence({ file }: { file: { documentId: string; fileVersion: number; originalFilename: string; mimeType: string; sizeBytes: number; sha256: string } }) {
  const [preview, setPreview] = useState(false);
  const path = `/api/attachments/${file.documentId}?fileVersion=${file.fileVersion}`;
  const kind = evidencePreviewKind(file.mimeType, file.sizeBytes);
  return <div className="space-y-2"><p>{file.originalFilename} · {file.sizeBytes.toLocaleString()} bytes · file version {file.fileVersion}</p><p className="break-all">Recorded SHA-256: {file.sha256}</p><p>Storage is checked against the recorded fingerprint before reading.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><a href={path}>Download original</a></Button>{['text', 'csv', 'tsv', 'image', 'pdf', 'audio', 'video'].includes(kind) && <Button size="sm" variant="outline" onClick={() => setPreview(value => !value)}>{preview ? 'Hide preview' : 'Preview'}</Button>}</div>
    {preview && (kind === 'csv' || kind === 'tsv') && <EvidenceTablePreview src={path} filename={file.originalFilename} sizeBytes={file.sizeBytes} delimiter={kind === 'csv' ? ',' : '\t'} />}
    {preview && kind === 'text' && <TextAttachmentPreview src={`${path}&preview=true`} filename={file.originalFilename} maximumBytes={256 * 1024} />}
    {preview && kind === 'audio' && <audio controls preload="metadata" src={`${path}&preview=true`}>Audio preview is not supported by this browser.</audio>}
    {preview && kind === 'video' && <video controls preload="metadata" className="max-h-96 max-w-full" src={`${path}&preview=true`}>Video preview is not supported by this browser.</video>}
    {preview && kind === 'pdf' && <PdfAttachmentPreview src={`${path}&preview=true`} filename={file.originalFilename} />}
    {/* Authenticated attachment bytes must bypass Next image optimization. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {preview && kind === 'image' && <img src={`${path}&preview=true`} alt={file.originalFilename} className="max-h-96 max-w-full object-contain" />}
    {kind === 'download' && <p>Preview unavailable; download the original to inspect it.</p>}
  </div>;
}
