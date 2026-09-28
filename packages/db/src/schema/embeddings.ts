import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";
import { documents } from "./documents";
import { projects } from "./projects";

const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    const normalized = value.trim().slice(1, -1);
    return normalized.length === 0
      ? []
      : normalized.split(",").map((component) => Number.parseFloat(component));
  },
});

export const embeddingProfiles = pgTable(
  "embedding_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scope: text("scope", { enum: ["global", "project", "personal"] })
      .default("global")
      .notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    status: text("status", { enum: ["disabled", "enabled", "failed"] })
      .default("disabled")
      .notNull(),
    provider: text("provider", { enum: ["openai_compatible"] })
      .default("openai_compatible")
      .notNull(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    secretRef: text("secret_ref").notNull(),
    timeoutMs: integer("timeout_ms").default(30_000).notNull(),
    batchSize: integer("batch_size").default(64).notNull(),
    maxConcurrency: integer("max_concurrency").default(2).notNull(),
    chunkSize: integer("chunk_size").default(1_200).notNull(),
    chunkOverlap: integer("chunk_overlap").default(120).notNull(),
    chunkingVersion: text("chunking_version").default("text-v1").notNull(),
    retentionGenerations: integer("retention_generations").default(2).notNull(),
    configurationHash: text("configuration_hash").notNull(),
    activeGenerationId: uuid("active_generation_id"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    version: integer("version").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdByType: actorTypeEnum("created_by_type").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedByType: actorTypeEnum("updated_by_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_embedding_profiles_global_name")
      .on(table.name)
      .where(sql`${table.scope} = 'global'`),
    uniqueIndex("idx_embedding_profiles_project_name")
      .on(table.projectId, table.name)
      .where(sql`${table.scope} = 'project'`),
    uniqueIndex("idx_embedding_profiles_personal_name")
      .on(table.personalOwnerId, table.personalOwnerType, table.name)
      .where(sql`${table.scope} = 'personal'`),
    index("idx_embedding_profiles_status").on(table.status),
    index("idx_embedding_profiles_active_generation").on(table.activeGenerationId),
  ],
);

export const embeddingGenerations = pgTable(
  "embedding_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .references(() => embeddingProfiles.id, { onDelete: "cascade" })
      .notNull(),
    generationNumber: integer("generation_number").notNull(),
    status: text("status", {
      enum: ["building", "active", "failed", "retired"],
    }).default("building").notNull(),
    provider: text("provider", { enum: ["openai_compatible"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    chunkOverlap: integer("chunk_overlap").notNull(),
    chunkingVersion: text("chunking_version").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    totalDocuments: integer("total_documents").default(0).notNull(),
    coveredDocuments: integer("covered_documents").default(0).notNull(),
    totalChunks: integer("total_chunks").default(0).notNull(),
    embeddedChunks: integer("embedded_chunks").default(0).notNull(),
    failedChunks: integer("failed_chunks").default(0).notNull(),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    createdBy: text("created_by").notNull(),
    createdByType: actorTypeEnum("created_by_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    buildCompletedAt: timestamp("build_completed_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_embedding_generations_profile_number").on(
      table.profileId,
      table.generationNumber,
    ),
    uniqueIndex("idx_embedding_generations_profile_config").on(
      table.profileId,
      table.configurationHash,
    ),
    uniqueIndex("idx_embedding_generations_one_active")
      .on(table.profileId)
      .where(sql`${table.status} = 'active'`),
    index("idx_embedding_generations_status").on(table.status),
  ],
);

export const embeddingDocumentChunks = pgTable(
  "embedding_document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id")
      .references(() => embeddingGenerations.id, { onDelete: "cascade" })
      .notNull(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    documentVersion: integer("document_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    tokenCount: integer("token_count"),
    characterStart: integer("character_start").notNull(),
    characterEnd: integer("character_end").notNull(),
    scope: text("scope", { enum: ["global", "project", "personal"] }).notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_embedding_chunks_generation_document_index").on(
      table.generationId,
      table.documentId,
      table.chunkIndex,
    ),
    index("idx_embedding_chunks_document").on(table.documentId),
    index("idx_embedding_chunks_scope").on(
      table.generationId,
      table.scope,
      table.projectId,
      table.personalOwnerId,
      table.personalOwnerType,
    ),
    index("idx_embedding_chunks_content_hash").on(table.generationId, table.contentHash),
  ],
);

export const documentEmbeddings = pgTable(
  "document_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id")
      .references(() => embeddingGenerations.id, { onDelete: "cascade" })
      .notNull(),
    chunkId: uuid("chunk_id")
      .references(() => embeddingDocumentChunks.id, { onDelete: "cascade" })
      .notNull(),
    embedding: embeddingVector("embedding").notNull(),
    dimensions: integer("dimensions").notNull(),
    contentHash: text("content_hash").notNull(),
    providerRequestId: text("provider_request_id"),
    usageTokens: integer("usage_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_document_embeddings_generation_chunk").on(
      table.generationId,
      table.chunkId,
    ),
    index("idx_document_embeddings_generation").on(table.generationId),
  ],
);

export const documentEmbeddingStates = pgTable(
  "document_embedding_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .references(() => embeddingProfiles.id, { onDelete: "cascade" })
      .notNull(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    generationId: uuid("generation_id").references(() => embeddingGenerations.id, {
      onDelete: "set null",
    }),
    state: text("state", {
      enum: ["missing", "stale", "indexing", "complete", "failed"],
    }).default("missing").notNull(),
    documentVersion: integer("document_version").notNull(),
    contentHash: text("content_hash").notNull(),
    totalChunks: integer("total_chunks").default(0).notNull(),
    embeddedChunks: integer("embedded_chunks").default(0).notNull(),
    failedChunks: integer("failed_chunks").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_document_embedding_states_profile_document").on(
      table.profileId,
      table.documentId,
    ),
    index("idx_document_embedding_states_profile_state").on(table.profileId, table.state),
    index("idx_document_embedding_states_generation").on(table.generationId),
  ],
);

export const embeddingJobs = pgTable(
  "embedding_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .references(() => embeddingProfiles.id, { onDelete: "cascade" })
      .notNull(),
    generationId: uuid("generation_id").references(() => embeddingGenerations.id, {
      onDelete: "set null",
    }),
    kind: text("kind", { enum: ["incremental", "full", "forced"] }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "pausing",
        "paused",
        "cancelling",
        "cancelled",
        "completed",
        "failed",
      ],
    }).default("queued").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedByType: actorTypeEnum("requested_by_type").notNull(),
    requestReason: text("request_reason"),
    totalItems: integer("total_items").default(0).notNull(),
    pendingItems: integer("pending_items").default(0).notNull(),
    completedItems: integer("completed_items").default(0).notNull(),
    failedItems: integer("failed_items").default(0).notNull(),
    skippedItems: integer("skipped_items").default(0).notNull(),
    promptTokens: integer("prompt_tokens").default(0).notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    maxRetries: integer("max_retries").default(5).notNull(),
    cursor: jsonb("cursor").$type<Record<string, unknown>>().default({}).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_embedding_jobs_profile_status").on(table.profileId, table.status),
    index("idx_embedding_jobs_generation").on(table.generationId),
    index("idx_embedding_jobs_lease").on(table.leaseExpiresAt),
    uniqueIndex("idx_embedding_jobs_one_active_generation")
      .on(table.generationId)
      .where(sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling')`),
  ],
);

export const embeddingJobItems = pgTable(
  "embedding_job_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .references(() => embeddingJobs.id, { onDelete: "cascade" })
      .notNull(),
    documentId: uuid("document_id").notNull(),
    action: text("action", { enum: ["upsert", "delete"] }).default("upsert").notNull(),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "skipped", "cancelled"],
    }).default("pending").notNull(),
    documentVersion: integer("document_version"),
    contentHash: text("content_hash"),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_embedding_job_items_job_document_action").on(
      table.jobId,
      table.documentId,
      table.action,
    ),
    index("idx_embedding_job_items_claimable").on(
      table.jobId,
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const embeddingLifecycleEvents = pgTable(
  "embedding_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .references(() => embeddingProfiles.id, { onDelete: "cascade" })
      .notNull(),
    generationId: uuid("generation_id").references(() => embeddingGenerations.id, {
      onDelete: "set null",
    }),
    jobId: uuid("job_id").references(() => embeddingJobs.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_embedding_lifecycle_events_profile_time").on(table.profileId, table.createdAt),
    index("idx_embedding_lifecycle_events_generation").on(table.generationId),
    index("idx_embedding_lifecycle_events_job").on(table.jobId),
  ],
);

export type EmbeddingProfile = typeof embeddingProfiles.$inferSelect;
export type EmbeddingGeneration = typeof embeddingGenerations.$inferSelect;
export type EmbeddingDocumentChunk = typeof embeddingDocumentChunks.$inferSelect;
export type DocumentEmbedding = typeof documentEmbeddings.$inferSelect;
export type DocumentEmbeddingState = typeof documentEmbeddingStates.$inferSelect;
export type EmbeddingJob = typeof embeddingJobs.$inferSelect;
export type EmbeddingJobItem = typeof embeddingJobItems.$inferSelect;
export type EmbeddingLifecycleEvent = typeof embeddingLifecycleEvents.$inferSelect;
