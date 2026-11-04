"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";

export function DependencyDeliveryInputs({ requirementId, sourceId, projectId, existingOutputIds, disabled }: { requirementId: string; sourceId: string; projectId: string; existingOutputIds: string[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [outputId, setOutputId] = useState("");
  const utils = trpc.useUtils();
  const permission = trpc.plan.capabilities.useQuery({ projectId }, { enabled: open, retry: false });
  const source = trpc.requirement.get.useQuery({ id: sourceId }, { enabled: open, retry: false });
  const add = trpc.requirement.addWorkflowInput.useMutation({
    onSuccess: () => { setOutputId(""); void utils.requirement.get.invalidate({ id: requirementId }); toast.success("Required delivery added"); },
    onError: error => toast.error("Could not add required delivery", { description: error.message }),
  });
  const outputs = (source.data?.workflowOutputs ?? []).filter(output => output.availability === "available");
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Required deliveries</summary><div className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
    <p className="text-muted-foreground">Choose a specific available output that this requirement needs. The requirement dependency itself can be added before any output exists.</p>
    {source.isLoading && <p role="status">Loading deliveries…</p>}{source.error && <p role="alert">Unable to load deliveries. Check access and retry.</p>}
    {source.data && (outputs.length ? <ul className="space-y-1">{outputs.filter(output => existingOutputIds.includes(output.id)).map(output => <li key={output.id} className="break-words">Required: {output.summary || output.url || output.relativePath || output.type.replaceAll("_", " ")}</li>)}</ul> : <p>No available deliveries yet.</p>)}
    {!disabled && permission.data?.canWrite && !permission.error && source.data && outputs.some(output => !existingOutputIds.includes(output.id)) && <><label className="block space-y-1"><span>Available delivery</span><select aria-label="Available delivery" className="w-full rounded-md border bg-background p-2" value={outputId} onChange={event => setOutputId(event.target.value)}><option value="">Select a delivery</option>{outputs.filter(output => !existingOutputIds.includes(output.id)).map(output => <option key={output.id} value={output.id}>{output.summary || output.url || output.relativePath || output.type.replaceAll("_", " ")}</option>)}</select></label><Button type="button" size="sm" variant="outline" disabled={!outputId || add.isPending} onClick={() => add.mutate({ requirementId, data: { outputId } })}>Add required delivery</Button></>}
    <p className="text-muted-foreground">Required deliveries remain attached if the requirement dependency is removed.</p>
  </div></details>;
}
