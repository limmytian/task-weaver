import { z } from "zod";
import { requirementLeaseFenceFields } from "./common";

const SECRET_URL_PATTERN = /:\/\/[^/@\s]+:[^/@\s]+@|[?&](?:access_?token|api_?key|password|secret|token)=|#/i;
const SECRET_POLICY_KEY_PATTERN = /(^|_)(?:api_?key|password|private_?key|secret|token|authorization)($|_)/i;

export const repositoryStatusSchema = z.enum(["active", "archived"]);
export const repositoryVisibilitySchema = z.enum(["instance", "restricted", "private"]);
export const repositoryTransportSchema = z.enum(["ssh", "https"]);
export const repositoryOperationSchema = z.enum(["read", "push", "forge"]);
export const repositoryReadinessSchema = z.enum([
  "available",
  "needs_configuration",
  "denied",
  "unavailable",
  "unknown",
]);
export const repositoryPushStatusSchema = z.enum([
  "pending",
  "not_needed",
  "pushing",
  "pushed",
  "failed",
]);
export const repositoryReviewStatusSchema = z.enum([
  "pending",
  "not_supported",
  "in_review",
  "approved",
  "changes_requested",
  "failed",
]);
export const repositoryMergeStatusSchema = z.enum([
  "pending",
  "not_needed",
  "ready",
  "merging",
  "merged",
  "failed",
]);
export const repositoryDeliveryStatusSchema = z.enum([
  "pending",
  "provisioning",
  "ready",
  "changed",
  "pushing",
  "pushed",
  "in_review",
  "ready_to_merge",
  "merged",
  "unchanged",
  "failed",
]);

export const repositoryDeliveryOperationSchema = z.enum([
  "clone",
  "fetch",
  "commit",
  "push",
  "pull_request",
  "review",
  "merge",
]);

export const repositoryOperationCheckpointSchema = z.object({
  operation: repositoryDeliveryOperationSchema,
  status: z.enum(["in_progress", "completed", "failed", "skipped"]),
  commit: z.string().max(128).optional(),
  summary: z.string().max(2000).optional(),
});

export const repositoryEndpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !SECRET_URL_PATTERN.test(value), {
    message: "Repository endpoints must not contain credentials, secret query parameters, or fragments",
  });

export const repositoryAuthPolicySchema = z
  .object({
    allowedTransports: z.array(repositoryTransportSchema).min(1).max(2).optional(),
    preferredTransport: repositoryTransportSchema.optional(),
    allowedOperations: z.array(repositoryOperationSchema).min(1).max(3).optional(),
    hostKeyPolicyRef: z.string().min(1).max(255).optional(),
    credentialProfileRef: z.string().min(1).max(255).optional(),
    allowNativeDefault: z.boolean().optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const key of Object.keys(data)) {
      if (SECRET_POLICY_KEY_PATTERN.test(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "Authentication policy cannot contain secrets" });
      }
    }
    if (
      data.preferredTransport &&
      data.allowedTransports &&
      !data.allowedTransports.includes(data.preferredTransport)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["preferredTransport"],
        message: "Preferred transport must be included in allowed transports",
      });
    }
  });

const repositoryCoordinatesSchema = z.object({
  host: z.string().min(1).max(255),
  namespace: z.string().min(1).max(1000),
  name: z.string().min(1).max(255),
});

export const createRepositorySchema = repositoryCoordinatesSchema
  .extend({
    displayName: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    provider: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/).default("generic"),
    providerExternalId: z.string().min(1).max(500).optional(),
    webUrl: repositoryEndpointSchema.optional(),
    httpsCloneUrl: repositoryEndpointSchema.optional(),
    sshCloneUrl: repositoryEndpointSchema.optional(),
    defaultBranch: z.string().min(1).max(500).optional(),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
    visibility: repositoryVisibilitySchema.default("instance"),
    ownerId: z.string().min(1).optional(),
    ownerType: z.enum(["human", "agent"]).optional(),
    authPolicy: repositoryAuthPolicySchema.default({}),
  })
  .superRefine((data, ctx) => {
    const hasOwner = Boolean(data.ownerId && data.ownerType);
    if (data.visibility === "instance" && (data.ownerId || data.ownerType)) {
      ctx.addIssue({ code: "custom", path: ["visibility"], message: "Instance repositories cannot set an owner" });
    }
    if (data.visibility !== "instance" && !hasOwner) {
      ctx.addIssue({ code: "custom", path: ["ownerId"], message: "Restricted repositories require ownerId and ownerType" });
    }
  });

export const updateRepositorySchema = z
  .object({
    displayName: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).nullable().optional(),
    provider: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
    providerExternalId: z.string().min(1).max(500).nullable().optional(),
    host: z.string().min(1).max(255).optional(),
    namespace: z.string().min(1).max(1000).optional(),
    name: z.string().min(1).max(255).optional(),
    webUrl: repositoryEndpointSchema.nullable().optional(),
    httpsCloneUrl: repositoryEndpointSchema.nullable().optional(),
    sshCloneUrl: repositoryEndpointSchema.nullable().optional(),
    defaultBranch: z.string().min(1).max(500).nullable().optional(),
    status: repositoryStatusSchema.optional(),
    tags: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
    visibility: repositoryVisibilitySchema.optional(),
    ownerId: z.string().min(1).nullable().optional(),
    ownerType: z.enum(["human", "agent"]).nullable().optional(),
    authPolicy: repositoryAuthPolicySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");

export const listRepositoriesSchema = z.object({
  query: z.string().max(500).optional(),
  provider: z.string().max(100).optional(),
  host: z.string().max(255).optional(),
  status: repositoryStatusSchema.optional(),
  visibility: repositoryVisibilitySchema.optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  sort: z.enum(["relevance", "recently_used", "usage", "name", "updated"]).default("relevance"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const addRequirementRepositorySchema = z.object({
  repositoryId: z.string().uuid(),
  baseBranch: z.string().min(1).max(500).optional(),
  workingBranch: z.string().min(1).max(500).optional(),
});

export const addTaskRepositorySchema = z.object({
  repositoryId: z.string().uuid(),
  addToRequirement: z.boolean().default(false),
  baseBranch: z.string().min(1).max(500).optional(),
  workingBranch: z.string().min(1).max(500).optional(),
});

export const updateRequirementRepositoryDeliverySchema = z
  .object({
    ...requirementLeaseFenceFields,
    workspaceKey: z.string().min(1).max(1000).nullable().optional(),
    manifestVersion: z.number().int().positive().nullable().optional(),
    provisionedAt: z.coerce.date().nullable().optional(),
    headCommit: z.string().max(128).nullable().optional(),
    pushedCommit: z.string().max(128).nullable().optional(),
    pushStatus: repositoryPushStatusSchema.optional(),
    pushedAt: z.coerce.date().nullable().optional(),
    pullRequestProvider: z.string().max(100).nullable().optional(),
    pullRequestExternalId: z.string().max(500).nullable().optional(),
    pullRequestUrl: repositoryEndpointSchema.nullable().optional(),
    reviewStatus: repositoryReviewStatusSchema.optional(),
    mergeStatus: repositoryMergeStatusSchema.optional(),
    mergedAt: z.coerce.date().nullable().optional(),
    deliveryStatus: repositoryDeliveryStatusSchema.optional(),
    failureCode: z.string().max(100).regex(/^[a-z0-9][a-z0-9_.-]*$/).nullable().optional(),
    failureSummary: z.string().max(2000).nullable().optional(),
    lastAttemptAt: z.coerce.date().nullable().optional(),
    reviewPolicyDecision: z.enum(["satisfied", "bypassed", "blocked"]).optional(),
    reviewPolicyEvidence: z.array(
      z.enum(["configured_checks", "ai_review", "human_approval", "forge_approval", "manual_override"]),
    ).max(5).optional(),
    manualOverrideReason: z.string().trim().min(1).max(2000).optional(),
    manualOverrideReference: z.string().trim().min(1).max(500).optional(),
    mergeMode: z.enum(["provider", "direct", "manual"]).nullable().optional(),
    manualActionUrl: repositoryEndpointSchema.nullable().optional(),
    externalState: z.record(z.string(), z.unknown()).optional(),
    externalStateUpdatedAt: z.coerce.date().nullable().optional(),
    externalSyncRevision: z.number().int().min(0).optional(),
    operationCheckpoint: repositoryOperationCheckpointSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one delivery field must be provided");

export const forgeCheckSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(500),
  state: z.enum(["queued", "running", "passed", "failed", "skipped"]),
  url: repositoryEndpointSchema.optional(),
  summary: z.string().max(4000).optional(),
});

export const forgeApprovalSnapshotSchema = z.object({
  actorId: z.string().trim().min(1).max(500),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
  submittedAt: z.string().datetime({ offset: true }).optional(),
  headCommit: z.string().trim().min(7).max(128).optional(),
});

export const forgePullRequestSnapshotSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  externalId: z.string().trim().min(1).max(500),
  url: repositoryEndpointSchema,
  state: z.enum(["open", "closed", "merged"]),
  headCommit: z.string().trim().min(7).max(128).nullable(),
  baseCommit: z.string().trim().min(7).max(128).nullable(),
  mergeable: z.boolean().nullable(),
  mergeState: z.string().max(500).nullable(),
  checks: z.array(forgeCheckSnapshotSchema).max(200),
  approvals: z.array(forgeApprovalSnapshotSchema).max(200),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

export const syncRequirementRepositoryForgeStateSchema = z.object({
  snapshot: forgePullRequestSnapshotSchema,
  idempotencyKey: z.string().trim().min(1).max(500),
  expectedRevision: z.number().int().min(0).optional(),
  observedAt: z.coerce.date().default(() => new Date()),
  ...requirementLeaseFenceFields,
});

export const reopenRequirementRepositoryDeliverySchema = z.object({
  ...requirementLeaseFenceFields,
  reason: z.string().trim().min(1).max(2000),
});

export const repositoryReadinessInputSchema = z.object({
  nodeId: z.string().min(1).max(255).optional(),
  operation: repositoryOperationSchema.default("read"),
  transport: repositoryTransportSchema.optional(),
});

export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;
export type RepositoryVisibility = z.infer<typeof repositoryVisibilitySchema>;
export type RepositoryReadiness = z.infer<typeof repositoryReadinessSchema>;
export type RepositoryPushStatus = z.infer<typeof repositoryPushStatusSchema>;
export type RepositoryReviewStatus = z.infer<typeof repositoryReviewStatusSchema>;
export type RepositoryMergeStatus = z.infer<typeof repositoryMergeStatusSchema>;
export type RepositoryDeliveryStatus = z.infer<typeof repositoryDeliveryStatusSchema>;
export type RepositoryDeliveryOperation = z.infer<typeof repositoryDeliveryOperationSchema>;
export type RepositoryOperationCheckpointInput = z.infer<typeof repositoryOperationCheckpointSchema>;
export type CreateRepositoryInput = z.infer<typeof createRepositorySchema>;
export type UpdateRepositoryInput = z.infer<typeof updateRepositorySchema>;
export type ListRepositoriesInput = z.infer<typeof listRepositoriesSchema>;
export type AddRequirementRepositoryInput = z.infer<typeof addRequirementRepositorySchema>;
export type AddTaskRepositoryInput = z.infer<typeof addTaskRepositorySchema>;
export type UpdateRequirementRepositoryDeliveryInput = z.infer<typeof updateRequirementRepositoryDeliverySchema>;
export type ForgePullRequestSnapshot = z.infer<typeof forgePullRequestSnapshotSchema>;
export type SyncRequirementRepositoryForgeStateInput = z.infer<typeof syncRequirementRepositoryForgeStateSchema>;
export type ReopenRequirementRepositoryDeliveryInput = z.infer<typeof reopenRequirementRepositoryDeliverySchema>;
export type RepositoryReadinessInput = z.infer<typeof repositoryReadinessInputSchema>;
