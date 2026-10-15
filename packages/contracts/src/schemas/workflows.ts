import { z } from "zod";
import { requirementLeaseFenceFields } from "./common";

export const workflowStageModeSchema = z.enum(["automatic", "manual", "skip"]);
export const deliveryMethodSchema = z.enum([
  "none", "comment", "attachment", "url", "local", "git_branch", "git_pr",
]);
export const integrationMethodSchema = z.enum([
  "none", "git_provider", "git_direct", "publish", "attach", "archive", "custom",
]);
export const workflowPresetSchema = z.enum([
  "basic", "comment", "attachment", "url", "local", "git_branch", "git_pr",
]);

const instructions = z.string().max(20_000).default("");

export const requirementWorkflowSchema = z.object({
  version: z.literal(1).default(1),
  worktreeMode: z.enum(["auto", "none", "isolated"]).default("auto"),
  delivery: z.object({
    mode: workflowStageModeSchema.default("automatic"),
    method: deliveryMethodSchema.default("none"),
    instructions,
  }),
  acceptance: z.object({
    mode: workflowStageModeSchema.default("skip"),
    instructions,
    requiredChecks: z.array(z.string().trim().min(1).max(500)).max(50).refine((checks) => new Set(checks).size === checks.length, "Check names must be unique").default([]),
    minimumHumanApprovals: z.number().int().min(0).max(1).default(0),
  }),
  integration: z.object({
    mode: workflowStageModeSchema.default("skip"),
    method: integrationMethodSchema.default("none"),
    instructions,
    target: z.string().trim().max(2000).optional(),
  }),
  localArtifactRetentionDays: z.number().int().min(1).max(3650).default(30),
  worktreeRetentionDays: z.number().int().min(0).max(3650).default(7),
}).superRefine((value, ctx) => {
  if (value.worktreeMode === "none" && (["git_branch", "git_pr"].includes(value.delivery.method) || ["git_provider", "git_direct"].includes(value.integration.method))) {
    ctx.addIssue({ code: "custom", path: ["worktreeMode"], message: "Git delivery or integration requires a worktree" });
  }
  if (value.delivery.mode === "skip" && value.delivery.method !== "none") {
    ctx.addIssue({ code: "custom", path: ["delivery", "method"], message: "Skipped delivery must use the none method" });
  }
  if (value.integration.mode === "skip" && value.integration.method !== "none") {
    ctx.addIssue({ code: "custom", path: ["integration", "method"], message: "Skipped integration must use the none method" });
  }
  if (value.acceptance.mode === "skip" && (value.acceptance.requiredChecks.length > 0 || value.acceptance.minimumHumanApprovals > 0)) {
    ctx.addIssue({ code: "custom", path: ["acceptance"], message: "Skipped acceptance cannot require checks or approvals" });
  }
  if (value.acceptance.mode === "automatic" && value.acceptance.minimumHumanApprovals > 0) {
    ctx.addIssue({ code: "custom", path: ["acceptance", "mode"], message: "Human approvals require manual acceptance" });
  }
  if (value.integration.mode === "automatic" && ["publish", "attach", "archive", "custom"].includes(value.integration.method) && !value.integration.instructions.trim()) {
    ctx.addIssue({ code: "custom", path: ["integration", "instructions"], message: "Automatic custom integration requires instructions" });
  }
});

export type RequirementWorkflow = z.infer<typeof requirementWorkflowSchema>;
export type WorkflowPreset = z.infer<typeof workflowPresetSchema>;

export function workflowNeedsWorktree(workflow: RequirementWorkflow): boolean {
  return workflow.worktreeMode === "isolated" || (workflow.worktreeMode === "auto"
    && (["git_branch", "git_pr"].includes(workflow.delivery.method) || ["git_provider", "git_direct"].includes(workflow.integration.method)));
}

export const BASIC_WORKFLOW: RequirementWorkflow = requirementWorkflowSchema.parse({
  delivery: {}, acceptance: {}, integration: {},
});

export function workflowFromPreset(preset: WorkflowPreset): RequirementWorkflow {
  if (preset === "basic") return BASIC_WORKFLOW;
  return requirementWorkflowSchema.parse({
    delivery: { method: preset },
    acceptance: preset === "git_pr" ? { mode: "automatic", instructions: "Review the delivered pull request changes and report any required corrections." } : {},
    integration: preset === "git_pr" ? { mode: "manual", method: "git_provider" } : {},
  });
}

export const workflowOutputTypeSchema = deliveryMethodSchema.exclude(["none"]);
export const registerWorkflowOutputSchema = z.object({
  type: workflowOutputTypeSchema,
  taskId: z.string().uuid().optional(),
  executionSliceId: z.string().uuid().optional(),
  requirementRepositoryId: z.string().uuid().optional(),
  referenceId: z.string().uuid().optional(),
  url: z.string().url().max(2000).refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL").optional(),
  nodeId: z.string().trim().min(1).max(255).optional(),
  relativePath: z.string().trim().min(1).max(2000).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  summary: z.string().trim().max(4000).optional(),
  ...requirementLeaseFenceFields,
}).superRefine((value, ctx) => {
  if (value.type === "comment" || value.type === "attachment") {
    if (!value.referenceId) ctx.addIssue({ code: "custom", path: ["referenceId"], message: "A platform reference is required" });
  }
  if (value.type === "url" && !value.url) ctx.addIssue({ code: "custom", path: ["url"], message: "A URL is required" });
  if (value.type === "local" && (!value.nodeId || !value.relativePath || value.sizeBytes === undefined || !value.sha256)) {
    ctx.addIssue({ code: "custom", path: ["relativePath"], message: "A node, path, size, and checksum are required" });
  }
  if (value.relativePath && (value.relativePath.startsWith("/") || value.relativePath.includes("\\") || value.relativePath.split("/").some((part) => part === ".." || part === "." || part === ""))) {
    ctx.addIssue({ code: "custom", path: ["relativePath"], message: "Use a normalized relative path" });
  }
});

export type RegisterWorkflowOutputInput = z.infer<typeof registerWorkflowOutputSchema>;

export const addWorkflowInputSchema = z.object({
  outputId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  executionSliceId: z.string().uuid().optional(),
  ...requirementLeaseFenceFields,
});
export type AddWorkflowInputInput = z.infer<typeof addWorkflowInputSchema>;

export const reportWorkflowOutputAvailabilitySchema = z.object({
  outputId: z.string().uuid(),
  nodeId: z.string().min(1).max(255),
  daemonId: z.string().uuid().optional(),
  availability: z.enum(["available", "missing", "changed"]),
  reason: z.string().trim().min(1).max(2000),
});
export type ReportWorkflowOutputAvailabilityInput = z.infer<typeof reportWorkflowOutputAvailabilitySchema>;
export const retireWorkflowOutputSchema = z.object({ outputId: z.string().uuid() });

export const advanceWorkflowStageSchema = z.object({
  stage: z.enum(["delivery", "acceptance", "integration"]),
  decision: z.enum(["complete", "changes_requested", "failed", "retry"]).default("complete"),
  reason: z.string().trim().min(1).max(4000),
  expectedRevision: z.number().int().min(0),
  checks: z.array(z.object({ name: z.string().trim().min(1).max(500), status: z.enum(["passed", "failed"]), summary: z.string().max(2000).optional() })).max(50).refine((checks) => new Set(checks.map((check) => check.name)).size === checks.length, "Check results must have unique names").default([]),
  ...requirementLeaseFenceFields,
});

export type AdvanceWorkflowStageInput = z.infer<typeof advanceWorkflowStageSchema>;

export const workflowAgentResultSchema = z.object({
  decision: z.enum(["complete", "changes_requested", "failed"]),
  reason: z.string().trim().min(1).max(4000),
  checks: advanceWorkflowStageSchema.shape.checks,
}).strict();
export type WorkflowAgentResult = z.infer<typeof workflowAgentResultSchema>;
