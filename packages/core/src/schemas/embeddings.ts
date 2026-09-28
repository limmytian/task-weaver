import { z } from "zod";

export const embeddingScopeSchema = z.enum(["global", "project", "personal"]);
export const embeddingProfileStatusSchema = z.enum(["disabled", "enabled", "failed"]);
export const embeddingGenerationStatusSchema = z.enum([
  "building",
  "active",
  "failed",
  "retired",
]);
export const embeddingCoverageStateSchema = z.enum([
  "missing",
  "stale",
  "indexing",
  "complete",
  "failed",
]);
export const embeddingJobKindSchema = z.enum(["incremental", "full", "forced"]);
export const embeddingJobStatusSchema = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
export const embeddingJobItemStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const embeddingSecretReferenceSchema = z
  .string()
  .min(3)
  .max(500)
  .regex(
    /^[a-z][a-z0-9+.-]*:\S+$/i,
    "secretRef must be an opaque reference such as env:OPENAI_API_KEY",
  );

export const embeddingBaseUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "baseUrl must use http or https",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "baseUrl cannot contain credentials, query parameters, or a fragment",
    });
  }
});

export const embeddingProviderConfigSchema = z.object({
  provider: z.literal("openai_compatible").default("openai_compatible"),
  baseUrl: embeddingBaseUrlSchema,
  model: z.string().trim().min(1).max(255),
  dimensions: z.number().int().min(1).max(2000),
  secretRef: embeddingSecretReferenceSchema,
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  batchSize: z.number().int().min(1).max(2048).default(64),
});

export const embeddingChunkingConfigSchema = z
  .object({
    chunkSize: z.number().int().min(100).max(32_000).default(1_200),
    chunkOverlap: z.number().int().min(0).default(120),
    chunkingVersion: z.string().trim().min(1).max(100).default("text-v1"),
  })
  .superRefine((value, context) => {
    if (value.chunkOverlap >= value.chunkSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkOverlap"],
        message: "chunkOverlap must be smaller than chunkSize",
      });
    }
  });

export const embeddingProfileScopeSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("global"),
    projectId: z.undefined().optional(),
    personalOwnerId: z.undefined().optional(),
    personalOwnerType: z.undefined().optional(),
  }),
  z.object({
    scope: z.literal("project"),
    projectId: z.string().uuid(),
    personalOwnerId: z.undefined().optional(),
    personalOwnerType: z.undefined().optional(),
  }),
  z.object({
    scope: z.literal("personal"),
    projectId: z.undefined().optional(),
    personalOwnerId: z.string().min(1),
    personalOwnerType: z.enum(["human", "agent"]),
  }),
]);

const embeddingProfileConfigurationSchema = embeddingProviderConfigSchema
  .and(embeddingChunkingConfigSchema)
  .and(z.object({
    maxConcurrency: z.number().int().min(1).max(32).default(2),
    retentionGenerations: z.number().int().min(1).max(100).default(2),
  }));

export const createEmbeddingProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    enabled: z.boolean().default(false),
  })
  .and(embeddingProfileScopeSchema)
  .and(embeddingProfileConfigurationSchema);

export const updateEmbeddingProfileSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  baseUrl: embeddingBaseUrlSchema.optional(),
  model: z.string().trim().min(1).max(255).optional(),
  dimensions: z.number().int().min(1).max(2000).optional(),
  secretRef: embeddingSecretReferenceSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  batchSize: z.number().int().min(1).max(2048).optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
  chunkSize: z.number().int().min(100).max(32_000).optional(),
  chunkOverlap: z.number().int().min(0).optional(),
  chunkingVersion: z.string().trim().min(1).max(100).optional(),
  retentionGenerations: z.number().int().min(1).max(100).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const listEmbeddingProfilesSchema = z.object({
  projectId: z.string().uuid().optional(),
  includeGlobal: z.boolean().default(true),
  includePersonal: z.boolean().default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  includeDisabled: z.boolean().default(true),
});

export const createEmbeddingGenerationSchema = embeddingProviderConfigSchema
  .omit({ secretRef: true, timeoutMs: true, batchSize: true })
  .and(embeddingChunkingConfigSchema)
  .and(z.object({
    profileId: z.string().uuid(),
    generationNumber: z.number().int().positive(),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  }));

export const createEmbeddingJobSchema = z.object({
  profileId: z.string().uuid(),
  generationId: z.string().uuid().optional(),
  kind: embeddingJobKindSchema,
  requestReason: z.string().trim().max(1000).optional(),
  maxRetries: z.number().int().min(0).max(100).default(5),
});

export const embeddingJobProgressSchema = z
  .object({
    totalItems: z.number().int().min(0),
    pendingItems: z.number().int().min(0),
    completedItems: z.number().int().min(0),
    failedItems: z.number().int().min(0),
    skippedItems: z.number().int().min(0),
    promptTokens: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    const accounted = value.pendingItems
      + value.completedItems
      + value.failedItems
      + value.skippedItems;
    if (accounted > value.totalItems) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "job progress counts cannot exceed totalItems",
      });
    }
  });

export type EmbeddingScope = z.infer<typeof embeddingScopeSchema>;
export type EmbeddingProfileStatus = z.infer<typeof embeddingProfileStatusSchema>;
export type EmbeddingGenerationStatus = z.infer<typeof embeddingGenerationStatusSchema>;
export type EmbeddingCoverageState = z.infer<typeof embeddingCoverageStateSchema>;
export type EmbeddingJobKind = z.infer<typeof embeddingJobKindSchema>;
export type EmbeddingJobStatus = z.infer<typeof embeddingJobStatusSchema>;
export type EmbeddingJobItemStatus = z.infer<typeof embeddingJobItemStatusSchema>;
export type EmbeddingProviderConfig = z.infer<typeof embeddingProviderConfigSchema>;
export type EmbeddingChunkingConfig = z.infer<typeof embeddingChunkingConfigSchema>;
export type CreateEmbeddingProfileInput = z.infer<typeof createEmbeddingProfileSchema>;
export type UpdateEmbeddingProfileInput = z.infer<typeof updateEmbeddingProfileSchema>;
export type ListEmbeddingProfilesInput = z.infer<typeof listEmbeddingProfilesSchema>;
export type CreateEmbeddingGenerationInput = z.infer<typeof createEmbeddingGenerationSchema>;
export type CreateEmbeddingJobInput = z.infer<typeof createEmbeddingJobSchema>;
export type EmbeddingJobProgress = z.infer<typeof embeddingJobProgressSchema>;
