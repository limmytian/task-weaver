"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { requirementWorkflowSchema, workflowFromPreset, workflowPresetSchema, BASIC_WORKFLOW, type RequirementWorkflow } from "@task-weaver/contracts";
import { WorkflowEditor } from "@/components/workflow-editor";

function defaultRequirementDate() {
  return new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
}

export function CreateRequirementDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [status, setStatus] = useState<string>("draft");
  const [workflowPreset, setWorkflowPreset] = useState<string>("project");
  const [customWorkflow, setCustomWorkflow] = useState<RequirementWorkflow>(BASIC_WORKFLOW);
  const [expectedAt, setExpectedAt] = useState(defaultRequirementDate);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const project = trpc.project.get.useQuery({ id: projectId }, { enabled: open });
  const inheritedWorkflow = requirementWorkflowSchema.safeParse(project.data?.defaultWorkflow ?? BASIC_WORKFLOW);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setStatus("draft");
    setWorkflowPreset("project");
    setCustomWorkflow(BASIC_WORKFLOW);
    setExpectedAt(defaultRequirementDate());
    setSubmitAttempted(false);
  };

  const isDirty =
    title.trim().length > 0 ||
    description.trim().length > 0 ||
    priority !== "medium" ||
    status !== "draft" ||
    workflowPreset !== "project" ||
    expectedAt !== defaultRequirementDate();
  const titleError = submitAttempted && !title.trim() ? "Requirement title is required." : null;

  const createReq = trpc.requirement.create.useMutation({
    onSuccess: () => {
      utils.requirement.list.invalidate({ projectId });
      resetForm();
      onOpenChange(false);
      toast.success("Requirement created");
    },
    onError: (err) => toast.error("Failed to create requirement", { description: err.message }),
  });
  const canSubmit = title.trim().length > 0 && !createReq.isPending;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDirty && !createReq.isPending) {
      setDiscardConfirmOpen(true);
      return;
    }
    if (nextOpen) setSubmitAttempted(false);
    onOpenChange(nextOpen);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!title.trim()) return;
    let workflow: ReturnType<typeof requirementWorkflowSchema.parse> | undefined;
    if (workflowPreset !== "project") {
      try {
        workflow = requirementWorkflowSchema.parse(customWorkflow);
      } catch (error) {
        toast.error("Invalid workflow", { description: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    createReq.mutate({
      projectId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority: priority as "low" | "medium" | "high" | "critical",
      status: status as "draft" | "approved" | "in_progress" | "in_review" | "ready_to_merge" | "done",
      expectedAt: expectedAt ? new Date(expectedAt + "T00:00:00") : undefined,
      workflow,
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create Requirement</DialogTitle>
              <DialogDescription>
                Add a new requirement to this project.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Title <span className="text-destructive">*</span>
                </label>
                <Input
                  placeholder="Requirement title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-invalid={Boolean(titleError)}
                  autoFocus
                />
                {titleError && (
                  <p className="mt-1 text-xs text-destructive">{titleError}</p>
                )}
              </div>
              <Textarea
                placeholder="Description (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
              <div>
                <label className="mb-1.5 block text-sm font-medium">Delivery workflow</label>
                <Select value={workflowPreset} onValueChange={(preset) => { setWorkflowPreset(preset); if (preset === "custom") setCustomWorkflow(inheritedWorkflow.success ? inheritedWorkflow.data : BASIC_WORKFLOW); else if (preset !== "project") setCustomWorkflow(workflowFromPreset(workflowPresetSchema.parse(preset))); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">Project default</SelectItem>
                    <SelectItem value="basic">No output required</SelectItem>
                    <SelectItem value="comment">Comment</SelectItem>
                    <SelectItem value="attachment">Attachment</SelectItem>
                    <SelectItem value="url">URL</SelectItem>
                    <SelectItem value="local">Local file</SelectItem>
                    <SelectItem value="git_branch">Git branch</SelectItem>
                    <SelectItem value="git_pr">Pull request</SelectItem>
                    <SelectItem value="custom">Customize project default</SelectItem>
                  </SelectContent>
                </Select>
                {workflowPreset === "project" && inheritedWorkflow.success && <p className="mt-2 text-xs text-muted-foreground">Delivery: {inheritedWorkflow.data.delivery.method} · Acceptance: {inheritedWorkflow.data.acceptance.mode} · Integration: {inheritedWorkflow.data.integration.mode}</p>}
                {workflowPreset !== "project" && <div className="mt-3"><WorkflowEditor key={workflowPreset} value={customWorkflow} onChange={setCustomWorkflow} /></div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Expected Deadline
                </label>
                <Input
                  type="date"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createReq.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
              >
                {createReq.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title="Discard requirement draft?"
        description="The requirement form has unsaved changes."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          resetForm();
          setDiscardConfirmOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
