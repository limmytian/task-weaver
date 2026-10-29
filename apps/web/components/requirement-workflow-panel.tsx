"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BASIC_WORKFLOW, requirementWorkflowSchema, evidencePreviewKind, type RequirementWorkflow } from "@task-weaver/contracts";
import { readEvidencePreview } from "@/lib/evidence-preview-transfer";
import { recordedReviewChecks, type ReviewCheckStatus } from "@/lib/review-checks";
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
  const [checks, setChecks] = useState<Record<string, ReviewCheckStatus | undefined>>({});
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
      checks: recordedReviewChecks(workflow?.acceptance.requiredChecks ?? [], checks),
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
          {nextStage === "acceptance" && workflow.acceptance.requiredChecks.map((name) => <label key={name} className="flex flex-wrap items-center gap-2">{name}<select className="rounded border bg-background p-1" value={checks[name] ?? ""} onChange={(event) => setChecks({ ...checks, [name]: (event.target.value || undefined) as ReviewCheckStatus | undefined })}><option value="">Not recorded</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>)}
          <div className="flex flex-wrap gap-2"><Button onClick={() => decide("complete")} disabled={!reason.trim() || advance.isPending}>Complete {nextStage}</Button>{nextStage !== "delivery" && <Button variant="outline" onClick={() => decide("changes_requested")} disabled={!reason.trim() || advance.isPending}>Request changes</Button>}{nextStage && state[nextStage] === "failed" && <Button variant="outline" onClick={() => decide("retry")} disabled={!reason.trim() || advance.isPending}>Retry stage</Button>}</div>
        </div>}
      </>}
      {canEdit && (editing ? <div className="space-y-3"><WorkflowEditor value={definition} onChange={setDefinition} /><div className="flex gap-2"><Button onClick={save} disabled={update.isPending}>Save workflow</Button><Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div></div> : <Button variant="outline" onClick={() => { setDefinition(workflow ?? BASIC_WORKFLOW); setEditing(true); }}>{workflow ? "Edit workflow" : "Configure workflow"}</Button>)}
    </CardContent>
  </Card>;
}

function EvidenceMetadata({ requirementId, outputId }: { requirementId: string; outputId: string }) {
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
  return <div className="mt-2 space-y-1"><Button size="sm" variant="outline" onClick={() => setOpen(value => !value)}>{open ? "Hide evidence details" : "Evidence details"}</Button>
    {open && evidence.isLoading && <p>Loading evidence…</p>}
    {open && evidence.error && <div role="alert"><p>Evidence is unavailable or access is denied.</p><Button size="sm" variant="outline" disabled={evidence.isFetching} onClick={() => void evidence.refetch()}>Retry</Button></div>}
    {open && !evidence.error && evidence.data && <div className="space-y-1 text-xs"><p>Source: {evidence.data.kind} · {evidence.data.availability}</p>
      {evidence.data.kind === "local" && evidence.data.availability !== "retired" && <><p>{evidence.data.originalFilename} · {evidence.data.sizeBytes} bytes</p><p>SHA-256: {evidence.data.sha256}</p><p>Preview transfers and verifies the entire file from its node before displaying a bounded sample. A connected compatible producer and enabled evidence service are required.</p><div className="flex flex-wrap gap-2">{evidencePreviewKind(evidence.data.mimeType, evidence.data.sizeBytes) !== 'download' && <Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('preview'); }}>Preview</Button>}<Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('download'); }}>Download original</Button>{!capabilities.error && capabilities.data?.canWrite && <Button size="sm" variant="outline" disabled={Boolean(controller) || evidence.data.availability !== 'available'} onClick={() => { void transfer('promotion'); }}>Save as attachment</Button>}{controller && <Button size="sm" variant="ghost" onClick={() => controller.abort()}>Cancel request</Button>}</div>{localPreview && <LocalEvidencePreview preview={localPreview} />}</>}
      {evidence.data.kind === "attachment" && evidence.data.availability !== "retired" && <PinnedAttachmentEvidence file={evidence.data} />}
      {evidence.data.availability === "retired" && <p>This output has been retired.</p>}
      {evidence.data.kind === "git" && <GitEvidence requirementId={requirementId} outputId={outputId} headCommit={evidence.data.headCommit} />}
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

function GitEvidence({ requirementId, outputId, headCommit }: { requirementId: string; outputId: string; headCommit: string }) {
  const comparison = trpc.requirement.compareGitEvidence.useMutation();
  const [selected, setSelected] = useState<number | null>(null);
  const selectedFile = selected === null ? undefined : comparison.data?.files[selected];
  const file = trpc.requirement.gitEvidenceFile.useQuery({ requirementId, outputId, comparisonId: comparison.data?.comparisonId ?? "", path: selectedFile?.path ?? "" }, { enabled: Boolean(comparison.data?.comparisonId && selectedFile), retry: false });
  return <div className="space-y-2"><p className="break-all">Head commit: {headCommit}</p><Button size="sm" variant="outline" disabled={comparison.isPending} onClick={() => { setSelected(null); comparison.mutate({ requirementId, outputId }); }}>Open Git comparison</Button>
    {comparison.isPending && <p>Opening comparison…</p>}{comparison.error && <p role="alert">Git comparison is unavailable or access is denied.</p>}
    {!comparison.error && comparison.data && <><p className="break-all">Base: {comparison.data.baseCommit}</p><p className="break-all">Merge base: {comparison.data.comparisonCommit}</p><p>Comparison mode: merge base to head</p>{comparison.data.truncated && <p role="status">The comparison exceeds the display limit; some changes are omitted.</p>}
      <div className="grid gap-3 md:grid-cols-3"><ul className="max-h-96 space-y-1 overflow-auto">{comparison.data.files.map((entry, index) => <li key={`${entry.path}-${index}`}><Button size="sm" variant={selected === index ? "secondary" : "ghost"} className="h-auto max-w-full justify-start whitespace-normal break-all text-left" onClick={() => setSelected(index)}>{entry.status}: {entry.previousPath ? `${entry.previousPath} → ` : ""}{entry.path}</Button></li>)}</ul><div className="min-w-0 md:col-span-2">{file.isFetching && <p>Loading file…</p>}{file.error && <p role="alert">File is unavailable or access is denied.</p>}{!file.isFetching && !file.error && file.data && <><p className="break-all">{file.data.path}</p>{file.data.patchState === "available" ? <GitPatch path={file.data.path} patch={file.data.patch ?? ""} /> : <p>Diff unavailable for this file ({file.data.patchState}).</p>}</>}</div></div>
    </>}
  </div>;
}

function GitPatch({ path, patch }: { path: string; patch: string }) {
  const lines = patch.split("\n");
  return <><pre className="max-h-96 overflow-auto whitespace-pre text-xs">{lines.slice(0, 2000).map((line, index) => <span className={`block ${line.startsWith("+") ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-200" : line.startsWith("-") ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200" : line.startsWith("@@") ? "text-blue-700 dark:text-blue-400" : ""}`} key={index}>{line ? highlightGitDiffLine(path, line).map((span, i) => <span className={span.className} key={i}>{span.text}</span>) : " "}</span>)}</pre>{lines.length > 2000 && <p role="status">Diff display is limited to the first 2,000 lines.</p>}</>;
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
