import { z } from "zod";
import { stagedPlanSchema } from "./plans";

export const SAMPLE_PROJECT_NAME = "[Sample] First successful collaboration";
export const SAMPLE_PROJECT_DESCRIPTION = "Task Weaver first-success sample. Isolated practice data; archive this project to clean up. No agent execution is started automatically.";
export const firstSuccessQuerySchema = z.object({ projectId: z.string().uuid() });
export const firstSuccessStateSchema = z.object({
  projectId: z.string().uuid(), observedAt: z.string(), active: z.boolean(), canWrite: z.boolean(), canArchiveSample: z.boolean(), sample: z.boolean(),
  draftId: z.string().uuid().nullable(), appliedPlan: z.boolean(),
  requirement: z.object({ id: z.string().uuid(), title: z.string(), status: z.string(), hasTasks: z.boolean(), workComplete: z.boolean(), hasOutput: z.boolean(), reviewed: z.boolean() }).nullable(),
});

/** Practice content stays staged until the user validates and explicitly applies it. */
export function firstSuccessSamplePlan(projectId: string) {
  return stagedPlanSchema.parse({ projectId, requirements: [{
    key: "first-success-sample", title: "[Sample] Review a small written outcome", status: "draft", tags: ["sample:first-success"],
    description: "Practice planning and evidence review. Approve this requirement explicitly. Write one sentence describing the outcome in a task comment, mark the task done, register that comment as delivery evidence and review it. Agent setup is optional.",
    workflow: { worktreeMode: "none", delivery: { mode: "manual", method: "comment", instructions: "Register the task comment as evidence, inspect it and complete delivery with a reason." }, acceptance: { mode: "manual", minimumHumanApprovals: 1, instructions: "Read the comment output and record whether it meets the goal." }, integration: { mode: "skip", method: "none" } },
    tasks: [{ key: "first-success-outcome", title: "[Sample] Write a one-sentence outcome", description: "Add a task comment describing the outcome. Mark this task done, then use the requirement workflow to register the comment ID and review the output.", tags: ["sample:first-success"] }],
  }] });
}
