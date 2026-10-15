"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BASIC_WORKFLOW, requirementWorkflowSchema } from "@task-weaver/contracts";
import { trpc } from "@/trpc/client";
import { WorkflowEditor } from "@/components/workflow-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ProjectWorkflowSettings({ projectId, defaultWorkflow }: { projectId: string; defaultWorkflow: unknown }) {
  const initial = requirementWorkflowSchema.safeParse(defaultWorkflow);
  const [editorRevision, setEditorRevision] = useState(0);
  const [workflow, setWorkflow] = useState(initial.success ? initial.data : BASIC_WORKFLOW);
  const utils = trpc.useUtils();
  const update = trpc.project.update.useMutation({
    onSuccess: () => { void utils.project.get.invalidate({ id: projectId }); toast.success("Default workflow updated"); },
    onError: (error) => toast.error(error.message),
  });
  return <Card>
    <CardHeader><CardTitle>Default requirement workflow</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">New requirements inherit this workflow unless they provide an override. Existing requirements keep their resolved configuration.</p>
      <WorkflowEditor key={editorRevision} value={workflow} onChange={setWorkflow} />
      <div className="flex flex-wrap gap-2"><Button disabled={update.isPending} onClick={() => {
        const parsed = requirementWorkflowSchema.safeParse(workflow);
        if (!parsed.success) { toast.error("Invalid workflow", { description: parsed.error.issues.map((issue) => issue.message).join("; ") }); return; }
        update.mutate({ id: projectId, data: { defaultWorkflow: parsed.data } });
      }}>Save default workflow</Button><Button variant="outline" disabled={update.isPending} onClick={() => { setWorkflow(BASIC_WORKFLOW); setEditorRevision((revision) => revision + 1); update.mutate({ id: projectId, data: { defaultWorkflow: null } }); }}>Reset to basic workflow</Button></div>
    </CardContent>
  </Card>;
}
