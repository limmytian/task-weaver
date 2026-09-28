import { twSchema } from "./schema";

export const taskStatusEnum = twSchema.enum("task_status", [
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const taskPriorityEnum = twSchema.enum("task_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const taskScopeEnum = twSchema.enum("task_scope", [
  "project",
  "personal",
]);

export const dependencyTypeEnum = twSchema.enum("dependency_type", [
  "blocks",
  "related",
]);

export const requirementStatusEnum = twSchema.enum("requirement_status", [
  "draft",
  "approved",
  "in_progress",
  "in_review",
  "ready_to_merge",
  "done",
  "cancelled",
  "archived",
]);

export const requirementPriorityEnum = twSchema.enum("requirement_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const modelTierEnum = twSchema.enum("model_tier", [
  "fast",
  "standard",
  "strong",
]);

export const executionSliceStatusEnum = twSchema.enum("execution_slice_status", [
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const actorTypeEnum = twSchema.enum("actor_type", ["human", "agent"]);

export const daemonRoleEnum = twSchema.enum("daemon_role", [
  "executor",
  "reviewer",
  "merger",
]);

export const scheduleKindEnum = twSchema.enum("schedule_kind", [
  "one_off",
  "recurring",
]);

export const scheduleTargetScopeEnum = twSchema.enum("schedule_target_scope", [
  "project",
  "personal",
]);

export const scheduleRecurrenceSyntaxEnum = twSchema.enum(
  "schedule_recurrence_syntax",
  ["rrule", "cron"],
);

export const scheduleStatusEnum = twSchema.enum("schedule_status", [
  "active",
  "paused",
  "archived",
]);

export const scheduleRunStatusEnum = twSchema.enum("schedule_run_status", [
  "pending",
  "created",
  "skipped",
  "failed",
  "cancelled",
]);

export const scheduleCatchUpPolicyEnum = twSchema.enum("schedule_catch_up_policy", [
  "none",
  "latest",
  "all",
]);

export const skillPackageStatusEnum = twSchema.enum("skill_package_status", [
  "active",
  "deprecated",
  "archived",
  "deleted",
]);

export const skillPackageVersionStatusEnum = twSchema.enum("skill_package_version_status", [
  "active",
  "deprecated",
  "archived",
  "deleted",
]);

export const skillPackageSourceTypeEnum = twSchema.enum("skill_package_source_type", [
  "upload",
  "directory",
  "archive",
  "single_file",
  "seed",
  "external",
]);

export const skillPackageFileKindEnum = twSchema.enum("skill_package_file_kind", [
  "entry",
  "text",
  "asset",
  "binary",
]);

export const skillPackageStorageObjectKindEnum = twSchema.enum("skill_package_storage_object_kind", [
  "archive",
  "file",
]);
