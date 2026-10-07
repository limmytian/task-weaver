import {
  boolean,
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
import { projects } from "./projects";
import { requirements } from "./requirements";
import { requirementRepositories } from "./repositories";

export type ReviewMergeMode = "provider" | "direct" | "manual";

export interface ReviewRetryPolicy {
  maxAttempts: number;
  initialBackoffSeconds: number;
  maxBackoffSeconds: number;
}

export const reviewPolicies = pgTable(
  "review_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" }),
    requiredChecks: text("required_checks").array().default([]).notNull(),
    requireAiReview: boolean("require_ai_review").default(false).notNull(),
    minimumHumanApprovals: integer("minimum_human_approvals").default(0).notNull(),
    requireIndependentReviewer: boolean("require_independent_reviewer").default(false).notNull(),
    requireIndependentMerger: boolean("require_independent_merger").default(false).notNull(),
    allowedMergeModes: text("allowed_merge_modes")
      .array()
      .$type<ReviewMergeMode[]>()
      .default(["provider", "direct", "manual"])
      .notNull(),
    defaultMergeMode: text("default_merge_mode", {
      enum: ["provider", "direct", "manual"],
    }).default("direct").notNull(),
    baseBranch: text("base_branch").default("main").notNull(),
    retryPolicy: jsonb("retry_policy")
      .$type<ReviewRetryPolicy>()
      .default({ maxAttempts: 3, initialBackoffSeconds: 30, maxBackoffSeconds: 900 })
      .notNull(),
    allowManualOverride: boolean("allow_manual_override").default(false).notNull(),
    overrideRequiresReason: boolean("override_requires_reason").default(true).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_review_policies_project_default")
      .on(table.projectId)
      .where(sql`${table.requirementId} IS NULL`),
    uniqueIndex("idx_review_policies_requirement")
      .on(table.requirementId)
      .where(sql`${table.requirementId} IS NOT NULL`),
    index("idx_review_policies_project").on(table.projectId),
  ],
);

export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    requirementRepositoryId: uuid("requirement_repository_id")
      .references(() => requirementRepositories.id, { onDelete: "cascade" })
      .notNull(),
    attempt: integer("attempt").notNull(),
    headCommit: text("head_commit").notNull(),
    baseCommit: text("base_commit").notNull(),
    status: text("status", {
      enum: ["running", "approved", "changes_requested", "blocked", "failed", "superseded"],
    }).default("running").notNull(),
    executorActorId: text("executor_actor_id"),
    executorActorType: actorTypeEnum("executor_actor_type"),
    executorDaemonId: uuid("executor_daemon_id"),
    reviewerActorId: text("reviewer_actor_id").notNull(),
    reviewerActorType: actorTypeEnum("reviewer_actor_type").notNull(),
    reviewerDaemonId: uuid("reviewer_daemon_id"),
    leaseRunId: uuid("lease_run_id"),
    leaseGeneration: integer("lease_generation"),
    supersedesRunId: uuid("supersedes_run_id"),
    supersededByRunId: uuid("superseded_by_run_id"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_review_runs_repository_attempt").on(table.requirementRepositoryId, table.attempt),
    index("idx_review_runs_requirement_created").on(table.requirementId, table.createdAt),
    index("idx_review_runs_repository_head").on(table.requirementRepositoryId, table.headCommit),
    index("idx_review_runs_status").on(table.status),
  ],
);

export const reviewChecks = pgTable(
  "review_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewRunId: uuid("review_run_id")
      .references(() => reviewRuns.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    provider: text("provider").default("local").notNull(),
    status: text("status", {
      enum: ["queued", "running", "passed", "failed", "skipped"],
    }).default("queued").notNull(),
    externalUrl: text("external_url"),
    summary: text("summary"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_review_checks_run_name_provider").on(table.reviewRunId, table.name, table.provider),
    index("idx_review_checks_run_status").on(table.reviewRunId, table.status),
  ],
);

export const reviewFindings = pgTable(
  "review_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewRunId: uuid("review_run_id")
      .references(() => reviewRuns.id, { onDelete: "cascade" })
      .notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity", { enum: ["info", "low", "medium", "high", "critical"] }).notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    path: text("path"),
    line: integer("line"),
    status: text("status", { enum: ["open", "resolved", "dismissed"] }).default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_review_findings_run_fingerprint").on(table.reviewRunId, table.fingerprint),
    index("idx_review_findings_run_status").on(table.reviewRunId, table.status),
  ],
);

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewRunId: uuid("review_run_id")
      .references(() => reviewRuns.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind", { enum: ["ai", "human", "forge", "override"] }).notNull(),
    decision: text("decision", {
      enum: ["approved", "changes_requested", "abstained", "bypassed"],
    }).notNull(),
    headCommit: text("head_commit").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    daemonId: uuid("daemon_id"),
    summary: text("summary"),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_review_decisions_run_kind").on(table.reviewRunId, table.kind),
    index("idx_review_decisions_run_commit").on(table.reviewRunId, table.headCommit),
  ],
);
