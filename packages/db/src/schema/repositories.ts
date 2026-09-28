import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorTypeEnum } from "./enums";
import { requirements } from "./requirements";
import { tasks } from "./tasks";

export interface RepositoryAuthPolicy {
  allowedTransports?: ("ssh" | "https")[];
  preferredTransport?: "ssh" | "https";
  allowedOperations?: ("read" | "push" | "forge")[];
  hostKeyPolicyRef?: string;
  credentialProfileRef?: string;
  allowNativeDefault?: boolean;
  revision?: number;
}

export interface RepositoryOperationCheckpoint {
  status: "in_progress" | "completed" | "failed" | "skipped";
  attempt: number;
  updatedAt: string;
  commit?: string;
  summary?: string;
}

export interface RepositoryExternalState {
  provider?: string;
  externalId?: string;
  url?: string;
  pullRequestState?: "open" | "closed" | "merged";
  headCommit?: string | null;
  baseCommit?: string | null;
  mergeable?: boolean | null;
  mergeState?: string | null;
  checks?: Array<{ name: string; state: string; url?: string }>;
  approvals?: Array<{ actorId: string; state: string; submittedAt?: string; headCommit?: string }>;
  updatedAt?: string;
  observedAt?: string;
  idempotencyKey?: string;
}

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    provider: text("provider").default("generic").notNull(),
    providerExternalId: text("provider_external_id"),
    host: text("host").notNull(),
    namespace: text("namespace").notNull(),
    name: text("name").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    webUrl: text("web_url"),
    httpsCloneUrl: text("https_clone_url"),
    sshCloneUrl: text("ssh_clone_url"),
    defaultBranch: text("default_branch"),
    status: text("status", { enum: ["active", "archived"] })
      .default("active")
      .notNull(),
    tags: text("tags").array(),
    visibility: text("visibility", {
      enum: ["instance", "restricted", "private"],
    })
      .default("instance")
      .notNull(),
    ownerId: text("owner_id"),
    ownerType: actorTypeEnum("owner_type"),
    authPolicy: jsonb("auth_policy").$type<RepositoryAuthPolicy>().default({}).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_repositories_canonical_key_unique").on(table.canonicalKey),
    uniqueIndex("idx_repositories_provider_external_unique")
      .on(table.provider, table.providerExternalId)
      .where(sql`${table.providerExternalId} IS NOT NULL`),
    index("idx_repositories_status_updated").on(table.status, table.updatedAt, table.id),
    index("idx_repositories_provider_status").on(table.provider, table.status),
    index("idx_repositories_host_status").on(table.host, table.status),
    index("idx_repositories_visibility").on(table.visibility, table.ownerId, table.ownerType),
  ],
);

export const requirementRepositories = pgTable(
  "requirement_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    repositoryId: uuid("repository_id")
      .references(() => repositories.id, { onDelete: "restrict" })
      .notNull(),
    baseBranch: text("base_branch"),
    workingBranch: text("working_branch"),
    workspaceKey: text("workspace_key"),
    manifestVersion: integer("manifest_version"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    headCommit: text("head_commit"),
    pushedCommit: text("pushed_commit"),
    pushStatus: text("push_status", {
      enum: ["pending", "not_needed", "pushing", "pushed", "failed"],
    })
      .default("pending")
      .notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    pullRequestProvider: text("pull_request_provider"),
    pullRequestExternalId: text("pull_request_external_id"),
    pullRequestUrl: text("pull_request_url"),
    reviewStatus: text("review_status", {
      enum: ["pending", "not_supported", "in_review", "approved", "changes_requested", "failed"],
    })
      .default("pending")
      .notNull(),
    mergeStatus: text("merge_status", {
      enum: ["pending", "not_needed", "ready", "merging", "merged", "failed"],
    })
      .default("pending")
      .notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status", {
      enum: [
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
      ],
    })
      .default("pending")
      .notNull(),
    failureCode: text("failure_code"),
    failureSummary: text("failure_summary"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryPhase: text("retry_phase", {
      enum: ["execution", "review", "merge"],
    }),
    retryRole: text("retry_role", {
      enum: ["executor", "reviewer", "merger"],
    }),
    retryPolicy: text("retry_policy", {
      enum: ["automatic", "after_follow_up", "manual"],
    }),
    resumeOperation: text("resume_operation"),
    operationCheckpoints: jsonb("operation_checkpoints")
      .$type<Record<string, RepositoryOperationCheckpoint>>()
      .default({})
      .notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    executorActorId: text("executor_actor_id"),
    executorActorType: actorTypeEnum("executor_actor_type"),
    executorDaemonId: uuid("executor_daemon_id"),
    reviewerActorId: text("reviewer_actor_id"),
    reviewerActorType: actorTypeEnum("reviewer_actor_type"),
    reviewerDaemonId: uuid("reviewer_daemon_id"),
    mergerActorId: text("merger_actor_id"),
    mergerActorType: actorTypeEnum("merger_actor_type"),
    mergerDaemonId: uuid("merger_daemon_id"),
    mergeMode: text("merge_mode", { enum: ["provider", "direct", "manual"] }),
    manualActionUrl: text("manual_action_url"),
    externalState: jsonb("external_state").$type<RepositoryExternalState>().default({}).notNull(),
    externalStateUpdatedAt: timestamp("external_state_updated_at", { withTimezone: true }),
    externalSyncRevision: integer("external_sync_revision").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_requirement_repositories_unique").on(
      table.requirementId,
      table.repositoryId,
    ),
    index("idx_requirement_repositories_requirement").on(table.requirementId),
    index("idx_requirement_repositories_repository").on(table.repositoryId),
    index("idx_requirement_repositories_delivery").on(table.deliveryStatus),
    index("idx_requirement_repositories_retry_queue").on(
      table.retryRole,
      table.nextAttemptAt,
      table.deliveryStatus,
    ),
    index("idx_requirement_repositories_manual_merge")
      .on(table.mergeMode, table.deliveryStatus)
      .where(sql`${table.mergeMode} = 'manual'`),
  ],
);

export const taskRepositories = pgTable(
  "task_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    repositoryId: uuid("repository_id")
      .references(() => repositories.id, { onDelete: "restrict" })
      .notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_task_repositories_unique").on(table.taskId, table.repositoryId),
    index("idx_task_repositories_task").on(table.taskId),
    index("idx_task_repositories_repository").on(table.repositoryId),
  ],
);

export const repositoryCheckoutBindings = pgTable(
  "repository_checkout_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .references(() => repositories.id, { onDelete: "cascade" })
      .notNull(),
    nodeId: text("node_id").notNull(),
    checkoutPath: text("checkout_path").notNull(),
    remoteIdentity: text("remote_identity"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_repository_checkout_bindings_unique").on(
      table.repositoryId,
      table.nodeId,
    ),
    index("idx_repository_checkout_bindings_node").on(table.nodeId),
  ],
);
