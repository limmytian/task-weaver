"use client";

import { useState } from "react";
import { type RequirementWorkflow, deliveryMethodSchema, integrationMethodSchema } from "@task-weaver/contracts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const labels: Record<string, string> = {
  none: "No extra action", comment: "Platform comment", attachment: "Platform attachment", url: "External URL", local: "Local artifact",
  git_branch: "Git branch", git_pr: "Pull request", git_provider: "Merge through Git provider", git_direct: "Merge with Git",
  publish: "Publish", attach: "Attach outputs", archive: "Archive", custom: "Custom action",
};

export function WorkflowEditor({ value, onChange }: { value: RequirementWorkflow; onChange: (value: RequirementWorkflow) => void }) {
  const [criteriaText, setCriteriaText] = useState(value.acceptance.requiredChecks.join("\n"));
  const mode = (stage: "delivery" | "acceptance" | "integration", next: "automatic" | "manual" | "skip") => {
    const updated = { ...value, [stage]: { ...value[stage], mode: next } };
    if (next === "skip") {
      if (stage === "delivery") updated.delivery = { ...updated.delivery, method: "none" };
      if (stage === "integration") updated.integration = { ...updated.integration, method: "none" };
      if (stage === "acceptance") {
        updated.acceptance = { ...updated.acceptance, requiredChecks: [], minimumHumanApprovals: 0 };
        setCriteriaText("");
      }
    }
    onChange(updated);
  };
  return <div className="space-y-4">
    {(["delivery", "acceptance", "integration"] as const).map((stage) => <fieldset key={stage} className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium capitalize">{stage}</legend>
      <Select value={value[stage].mode} onValueChange={(next) => mode(stage, next as "automatic" | "manual" | "skip")}>
        <SelectTrigger aria-label={`${stage} mode`}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="automatic">Automatic</SelectItem><SelectItem value="manual">Human decision</SelectItem><SelectItem value="skip">Skip</SelectItem></SelectContent>
      </Select>
      {stage !== "acceptance" && value[stage].mode !== "skip" && <Select value={value[stage].method} onValueChange={(method) => onChange({ ...value, [stage]: { ...value[stage], method } })}>
        <SelectTrigger aria-label={`${stage} method`}><SelectValue /></SelectTrigger>
        <SelectContent>{(stage === "delivery" ? deliveryMethodSchema.options : integrationMethodSchema.options).map((method) => <SelectItem key={method} value={method}>{labels[method] ?? method}</SelectItem>)}</SelectContent>
      </Select>}
      {value[stage].mode !== "skip" && <Textarea aria-label={`${stage} instructions`} placeholder="Extra instructions (optional)" rows={3} value={value[stage].instructions} onChange={(event) => onChange({ ...value, [stage]: { ...value[stage], instructions: event.target.value } })} />}
      {stage === "acceptance" && value.acceptance.mode !== "skip" && <>
        <Textarea aria-label="Required acceptance criteria" placeholder="Required acceptance criteria, one per line" rows={3} value={criteriaText} onChange={(event) => { setCriteriaText(event.target.value); onChange({ ...value, acceptance: { ...value.acceptance, requiredChecks: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) } }); }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.acceptance.minimumHumanApprovals > 0} onChange={(event) => onChange({ ...value, acceptance: { ...value.acceptance, mode: event.target.checked ? "manual" : value.acceptance.mode, minimumHumanApprovals: event.target.checked ? 1 : 0 } })} />Require human approval</label>
      </>}
      {stage === "integration" && value.integration.mode !== "skip" && <Input aria-label="Integration target" placeholder="Target branch, location, or destination (optional)" value={value.integration.target ?? ""} onChange={(event) => onChange({ ...value, integration: { ...value.integration, target: event.target.value || undefined } })} />}
    </fieldset>)}
    <div className="space-y-2"><label className="text-sm font-medium">Repository workspace</label><Select value={value.worktreeMode} onValueChange={(worktreeMode) => onChange({ ...value, worktreeMode: worktreeMode as RequirementWorkflow["worktreeMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Create worktrees for Git delivery or integration</SelectItem><SelectItem value="none">Use an ordinary runtime directory</SelectItem><SelectItem value="isolated">Create worktrees for linked repository work</SelectItem></SelectContent></Select></div>
    <label className="block space-y-2 text-sm"><span>Minimum local artifact retention (days)</span><Input type="number" min={1} max={3650} value={value.localArtifactRetentionDays} onChange={(event) => onChange({ ...value, localArtifactRetentionDays: Number(event.target.value) })} /></label>
    <label className="block space-y-2 text-sm"><span>Completed worktree retention (days)</span><Input type="number" min={0} max={3650} value={value.worktreeRetentionDays} onChange={(event) => onChange({ ...value, worktreeRetentionDays: Number(event.target.value) })} /></label>
  </div>;
}
