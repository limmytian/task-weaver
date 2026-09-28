"use client";

import { useState, useEffect } from "react";
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

function defaultTaskDate() {
  return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
}

export function CreateTaskDialog({
  projectId,
  defaultRequirementId,
  open,
  onOpenChange,
}: {
  projectId: string;
  defaultRequirementId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [requirementId, setRequirementId] = useState<string>(defaultRequirementId ?? "");
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (defaultRequirementId) setRequirementId(defaultRequirementId);
  }, [defaultRequirementId]);
  const [expectedAt, setExpectedAt] = useState(defaultTaskDate);
  const utils = trpc.useUtils();

  const { data: requirements, isLoading: requirementsLoading } = trpc.requirement.list.useQuery(
    { projectId },
    { enabled: open },
  );

  const activeRequirements = requirements?.filter((r) => r.status !== "cancelled") ?? [];
  const defaultReq = defaultRequirementId ?? "";

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setRequirementId(defaultReq);
    setExpectedAt(defaultTaskDate());
    setSubmitAttempted(false);
  };

  const isDirty =
    title.trim().length > 0 ||
    description.trim().length > 0 ||
    priority !== "medium" ||
    requirementId !== defaultReq ||
    expectedAt !== defaultTaskDate();
  const titleError = submitAttempted && !title.trim() ? "Task title is required." : null;
  const requirementError =
    submitAttempted && !requirementId ? "Choose a requirement before creating the task." : null;
  const expectedError = submitAttempted && !expectedAt ? "Expected deadline is required." : null;

  const createTask = trpc.task.create.useMutation({
    onSuccess: () => {
      utils.task.board.invalidate({ projectId });
      utils.task.list.invalidate();
      utils.requirement.list.invalidate({ projectId });
      utils.task.gantt.invalidate({ projectId });
      utils.project.stats.invalidate({ id: projectId });
      resetForm();
      onOpenChange(false);
      toast.success("Task created");
    },
    onError: (err) => toast.error("Failed to create task", { description: err.message }),
  });
  const canSubmit =
    title.trim().length > 0 &&
    Boolean(requirementId) &&
    Boolean(expectedAt) &&
    !createTask.isPending;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDirty && !createTask.isPending) {
      setDiscardConfirmOpen(true);
      return;
    }
    if (nextOpen) setSubmitAttempted(false);
    onOpenChange(nextOpen);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!title.trim() || !requirementId || !expectedAt) return;
    createTask.mutate({
      projectId,
      requirementId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority: priority as "low" | "medium" | "high" | "urgent",
      expectedAt: new Date(expectedAt),
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create Task</DialogTitle>
              <DialogDescription>
                Add a new task under a requirement.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              {!defaultRequirementId && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">
                    Requirement <span className="text-destructive">*</span>
                  </label>
                  <Select value={requirementId} onValueChange={setRequirementId}>
                    <SelectTrigger aria-invalid={Boolean(requirementError)}>
                      <SelectValue placeholder={requirementsLoading ? "Loading requirements..." : "Select a requirement..."} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeRequirements.length === 0 ? (
                        <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                          No requirements yet. Create one first.
                        </div>
                      ) : (
                        activeRequirements.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.title}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {requirementError && (
                    <p className="mt-1 text-xs text-destructive">{requirementError}</p>
                  )}
                </div>
              )}
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Title <span className="text-destructive">*</span>
                </label>
                <Input
                  placeholder="Task title"
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
                rows={3}
              />
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Expected Deadline <span className="text-destructive">*</span>
                </label>
                <Input
                  type="date"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                  aria-invalid={Boolean(expectedError)}
                  required
                />
                {expectedError && (
                  <p className="mt-1 text-xs text-destructive">{expectedError}</p>
                )}
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createTask.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
              >
                {createTask.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title="Discard task draft?"
        description="The task form has unsaved changes."
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
