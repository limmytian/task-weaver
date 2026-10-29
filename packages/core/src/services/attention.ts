import { and, asc, eq, exists, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { daemonWorkerProgressHistory, tasks, taskDependencies, tiAgentRuns, executionControls, projects, requirements, requirementDependencies, requirementRepositories, repositories, type Database } from "@task-weaver/db";
import { attentionPageSchema, attentionQuerySchema, AuthorizationError, type AttentionCategory, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { canAccessResource, projectPredicate, requireResource, resourceAuthority, taskResourcePredicate } from "./resource-authorization";
import { visibleTiRuns } from "./metadata-authorization";
import { metadataReadScope } from "./metadata-read-scope";
import { repositoryPredicate } from "./repository-authorization";

export const attentionDescriptions: Record<AttentionCategory, { reason: string; nextAction: string }> = {
  recovery: { reason: "Execution evidence or recovery needs a human decision.", nextAction: "Inspect evidence and recovery controls" },
  failure: { reason: "The latest visible execution, repository delivery or a workflow stage failed.", nextAction: "Inspect the failed stage and delivery evidence" },
  review: { reason: "Delivered work is awaiting review or integration.", nextAction: "Review evidence and the next workflow stage" },
  blocked: { reason: "An unfinished task or requirement dependency blocks this work.", nextAction: "Inspect blocking requirements" },
};

/** One highest-priority condition per requirement; navigation never grants action authority. */
export function attentionCategory(facts: { recovery: boolean; failure: boolean; review: boolean; blocked: boolean }): AttentionCategory | null {
  return (["recovery", "failure", "review", "blocked"] as const).find(category => facts[category]) ?? null;
}

export function createAttentionService(context: VerifiedRequestContext) {
  return {
    async list(db: Database, raw: unknown) {
      const input = attentionQuerySchema.parse(raw);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        if (authority.bounds || authority.actor.type !== "human") throw new AuthorizationError();
        if (input.projectId) await requireResource(tx, authority, "project", input.projectId);
        const metadata = metadataReadScope(tx, authority, input.projectId);
        const visibleRuns = visibleTiRuns(tx, authority);
        const newerRun = alias(tiAgentRuns, "attention_newer_run");
        const executionFailure = exists(tx.select({ id: tiAgentRuns.id }).from(tiAgentRuns).innerJoin(tasks, eq(tasks.id, tiAgentRuns.taskId)).where(and(
          eq(tasks.requirementId, requirements.id), eq(tasks.projectId, requirements.projectId), taskResourcePredicate(authority),
          notInArray(tasks.status, ["done", "cancelled"]), inArray(tiAgentRuns.id, visibleRuns), eq(tiAgentRuns.status, "failed"),
          sql`NOT EXISTS (${tx.select({ id: newerRun.id }).from(newerRun).where(and(eq(newerRun.taskId, tiAgentRuns.taskId), or(gt(newerRun.createdAt, tiAgentRuns.createdAt), and(eq(newerRun.createdAt, tiAgentRuns.createdAt), gt(newerRun.id, tiAgentRuns.id)))))})`,
        )));
        // The latest historical observation is durable after a worker slot is reused.
        const daemonFailure = and(metadata.requirement, sql`(SELECT ${daemonWorkerProgressHistory.phase} FROM ${daemonWorkerProgressHistory} WHERE ${daemonWorkerProgressHistory.requirementId} = ${requirements.id} AND ${metadata.history} ORDER BY ${daemonWorkerProgressHistory.occurredAt} DESC, ${daemonWorkerProgressHistory.id} DESC LIMIT 1) = 'failed'`)!;
        const upstreamTask = alias(tasks, "attention_upstream_task");
        const taskBlocked = exists(tx.select({ id: tasks.id }).from(tasks).innerJoin(taskDependencies, eq(taskDependencies.taskId, tasks.id))
          .innerJoin(upstreamTask, eq(upstreamTask.id, taskDependencies.dependsOnTaskId)).where(and(
            eq(tasks.requirementId, requirements.id), eq(tasks.projectId, requirements.projectId), taskResourcePredicate(authority), notInArray(tasks.status, ["done", "cancelled"]),
            eq(taskDependencies.type, "blocks"), eq(upstreamTask.projectId, requirements.projectId), sql`${upstreamTask.status} <> 'done'`,
          )));
        const upstream = alias(requirements, "attention_upstream");
        // Only the newest control describes the current recovery decision.
        const latestPhase = sql<string>`(SELECT ${executionControls.phase} FROM ${executionControls} WHERE ${executionControls.requirementId} = ${requirements.id} AND ${executionControls.projectId} = ${requirements.projectId} ORDER BY ${executionControls.createdAt} DESC, ${executionControls.id} DESC LIMIT 1)`;
        const recovery = or(eq(requirements.evidenceNeedsReview, true), inArray(latestPhase, ["manual", "blocked"]))!;
        const failure = or(executionFailure, daemonFailure, exists(tx.select({ id: requirementRepositories.id }).from(requirementRepositories)
          .innerJoin(repositories, eq(repositories.id, requirementRepositories.repositoryId))
          .where(and(eq(requirementRepositories.requirementId, requirements.id), eq(requirementRepositories.deliveryStatus, "failed"), repositoryPredicate(authority)))),
          sql`${requirements.workflowState} @> '{"delivery":"failed"}' OR ${requirements.workflowState} @> '{"acceptance":"failed"}' OR ${requirements.workflowState} @> '{"integration":"failed"}'`)!;
        const review = inArray(requirements.status, ["in_review", "ready_to_merge"]);
        const blocked = or(taskBlocked, exists(tx.select({ id: requirementDependencies.id }).from(requirementDependencies)
          .innerJoin(upstream, eq(upstream.id, requirementDependencies.dependsOnRequirementId))
          .where(and(eq(requirementDependencies.requirementId, requirements.id), eq(requirementDependencies.type, "blocks"),
            eq(upstream.projectId, requirements.projectId), projectPredicate(authority, "resource.read", upstream.projectId), notInArray(upstream.status, ["done", "cancelled"])))))!;
        const category = sql<AttentionCategory>`CASE WHEN ${recovery} THEN 'recovery' WHEN ${failure} THEN 'failure' WHEN ${review} THEN 'review' WHEN ${blocked} THEN 'blocked' END`;
        const rows = await tx.select({ id: requirements.id, projectId: requirements.projectId, title: sql<string>`left(${requirements.title}, 500)`,
          projectName: sql<string>`left(${projects.name}, 255)`, updatedAt: requirements.updatedAt, planRevision: requirements.planRevision, category })
          .from(requirements).innerJoin(projects, eq(projects.id, requirements.projectId)).where(and(
            projectPredicate(authority, "resource.read", requirements.projectId), eq(projects.status, "active"),
            notInArray(requirements.status, ["done", "cancelled", "archived"]),
            input.projectId ? eq(requirements.projectId, input.projectId) : undefined,
            input.after ? gt(requirements.id, input.after) : undefined,
            input.category ? eq(category, input.category) : or(recovery, failure, review, blocked),
          )).orderBy(asc(requirements.id)).limit(input.limit + 1);
        return attentionPageSchema.parse({
          items: rows.slice(0, input.limit).map(row => ({ ...row, requirementId: row.id,
            id: `${row.id}:${row.category}`, ...attentionDescriptions[row.category],
            canAct: canAccessResource(authority, row, row.category === "recovery" ? "project.manage" : "resource.write"),
            responsibility: "available_to_you", updatedAt: row.updatedAt.toISOString() })),
          next: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
          observedAt: new Date().toISOString(), countScope: "page_only",
        });
      });
    },
  };
}
