import { requireDaemonLease } from './daemon-lease-authorization';
import { authorizeDaemonOperation } from './daemon-authorization';
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentUsageRuns, reviewRuns, requirementRepositories, repositories, tasks, documents, requirements, projects, activityLog, tiAgentRuns, tiAgentModelConfigs, tiAgentPolicies, schedules, scheduleRuns, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, ValidationError, activityQuerySchema } from "@task-weaver/contracts";
import { validateAssignee, requireScope, taskResourcePredicate, resourcePredicate, projectPredicate, requireResource, type ResourceAuthority } from "./resource-authorization";
import { repositoryPredicate, requireRepository } from "./repository-authorization";

import { metadataReadScope } from "./metadata-read-scope";
import { canManageProvider } from "./asset-authorization";
import { loadActivePrincipal } from "./auth-principals";

/** Stored relations must agree before any pagination, totals or usage coverage. */
export function usageRelationPredicate() {
  return sql`EXISTS (SELECT 1 FROM requirements r WHERE r.id = ${agentUsageRuns.requirementId} AND r.project_id = ${agentUsageRuns.projectId})
    AND (${agentUsageRuns.taskId} IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${agentUsageRuns.taskId} AND t.scope = 'project' AND t.project_id = ${agentUsageRuns.projectId} AND t.requirement_id = ${agentUsageRuns.requirementId}))
    AND (${agentUsageRuns.tiRunId} IS NULL OR EXISTS (SELECT 1 FROM ti_agent_runs ti JOIN tasks t ON t.id = ti.task_id WHERE ti.id = ${agentUsageRuns.tiRunId} AND t.project_id = ${agentUsageRuns.projectId} AND t.requirement_id = ${agentUsageRuns.requirementId} AND (${agentUsageRuns.taskId} IS NULL OR ti.task_id = ${agentUsageRuns.taskId})))`;
}

export async function authorizeMetadataOperation(db: Database, authority: ResourceAuthority, group: "usage" | "review" | "ti" | "activity" | "schedule" | "observability" | "metrics" | "progress" | "daemon", name: string, call: any[]) {
  if (authority.bounds) throw new AuthorizationError();
  if ((group === "daemon" || group === "progress") && await authorizeDaemonOperation(db, authority, group, name, call)) return;
  if (["observability", "metrics", "progress", "daemon"].includes(group)) {
    if (!["getDaemonObservabilityOverview", "getDaemonMetricsReport", "listCorrelatedHistory", "listBoundedLogTail", "listRequirementTimeline", "listDaemonControlPlaneQueues"].includes(name)) throw new AuthorizationError();
    const input = call[1] ?? {};
    if (input.projectId) await requireResource(db, authority, "project", input.projectId, "audit.read");
    if (input.requirementId) await requireResource(db, authority, "requirement", input.requirementId, "audit.read");
    const scope = metadataReadScope(db, authority, input.projectId);
    call[name === "getDaemonMetricsReport" ? 3 : name === "listDaemonControlPlaneQueues" ? 1 : 2] = scope;
    return;
  }
  if (group === "schedule") {
    if (name === "listSchedules") {
      if (call[1].projectId) await requireResource(db, authority, "project", call[1].projectId);
      const valid = db.select({ id: schedules.id }).from(schedules).where(schedulePredicate(authority));
      call[2] = inArray(schedules.id, valid);
      return;
    }
    if (name === "createSchedule") {
      call[1] = await authorizeScheduleInput(db, authority, { ...call[1] });
      return;
    }
    if (["getSchedule", "updateSchedule", "archiveSchedule", "listScheduleRuns", "runScheduleNow"].includes(name)) {
      const [row] = await db.select().from(schedules).where(and(eq(schedules.id, call[1]), schedulePredicate(authority))).limit(1);
      if (!row) throw new NotFoundError("Resource not found");
      if (["updateSchedule", "archiveSchedule", "runScheduleNow"].includes(name)) requireScope(authority, row, row.projectId ? "project.manage" : "resource.write");
      if (name === "runScheduleNow") {
        await authorizeScheduleInput(db, authority, { ...row });
        if (row.status !== "active") throw new AuthorizationError();
      }
      if (name === "updateSchedule") {
        const merged = await authorizeScheduleInput(db, authority, { ...row, ...call[2] });
        call[2] = { ...call[2], projectId: merged.projectId, requirementId: merged.requirementId, targetScope: merged.targetScope, personalOwnerId: merged.personalOwnerId, personalOwnerType: merged.personalOwnerType };
      }
      return;
    }
    // Acquisition and run-now create executor work and stay closed until delegation is implemented.
    throw new AuthorizationError();
  }
  if (group === "ti") {
    if (["upsertModelConfig", "listModelConfigs", "setDefaultModel", "upsertPolicy", "getPolicy", "resolveModel"].includes(name)) {
      const input = { ...call[1] };
      const ownerId = input.ownerId ?? (authority.actor.type === "human" ? authority.actor.id : authority.actor.managedByActorId);
      const scope = { personalOwnerId: ownerId, personalOwnerType: input.ownerType ?? "human" };
      const write = ["upsertModelConfig", "setDefaultModel", "upsertPolicy"].includes(name);
      requireScope(authority, scope, write ? "resource.write" : "resource.read");
      if ((await loadActivePrincipal(db, ownerId)).type !== "human") throw new AuthorizationError();
      // These providers resolve environment credentials on the instance, including implicit defaults.
      if (name === "upsertModelConfig" && !canManageProvider(authority, scope)) throw new AuthorizationError();
      call[1] = { ...input, ownerId, ownerType: "human" };
      return;
    }
    if (["listRuns", "getRun"].includes(name)) {
      const valid = visibleTiRuns(db, authority);
      if (name === "listRuns") {
        if (call[1].taskId) await requireResource(db, authority, "task", call[1].taskId);
        call[2] = inArray(tiAgentRuns.id, valid);
      } else {
        const [run] = await db.select().from(tiAgentRuns).where(and(eq(tiAgentRuns.id, call[1]), inArray(tiAgentRuns.id, valid))).limit(1);
        if (!run) throw new NotFoundError("Resource not found");
      }
      return;
    }
    throw new AuthorizationError();
  }
  if (group === "activity") {
    if (!["listActivityLog", "exportActivityLog"].includes(name)) throw new AuthorizationError();
    const parsed = activityQuerySchema.safeParse(call[1] ?? {});
    if (!parsed.success) throw new ValidationError("Invalid activity query");
    const input = parsed.data;
    call[1] = input;
    if (input.projectId) await requireResource(db, authority, "project", input.projectId, "audit.read");
    if (name === "listActivityLog" && (!Number.isInteger(input.limit ?? 50) || (input.limit ?? 50) < 1 || (input.limit ?? 50) > 100 || !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0)) throw new ValidationError("Invalid activity pagination");
    for (const date of [input.since, input.until]) if (date && !Number.isFinite(Date.parse(date))) throw new ValidationError("Invalid activity timestamp");
    const projectIds = db.select({ id: projects.id }).from(projects).where(projectPredicate(authority, "audit.read"));
    const reqIds = db.select({ id: requirements.id }).from(requirements).where(projectPredicate(authority, "audit.read", requirements.projectId));
    const taskIds = db.select({ id: tasks.id }).from(tasks).where(or(and(eq(tasks.scope, "project"), and(taskResourcePredicate(authority), projectPredicate(authority, "audit.read", tasks.projectId))), and(eq(tasks.scope, "personal"), taskResourcePredicate(authority))));
    const docIds = db.select({ id: documents.id }).from(documents).where(or(and(sql`${documents.projectId} IS NOT NULL`, resourcePredicate(authority, documents, "audit.read")), and(sql`${documents.projectId} IS NULL`, resourcePredicate(authority, documents))));
    const catalogManagement = or(
      ...(authority.actor.type === "human" && authority.actor.instanceRole === "admin" && authority.grants.some(g => g.scope === "global" && g.permissions.includes("repository.manage")) ? [eq(repositories.visibility, "instance")] : []),
      ...authority.grants.filter(g => g.scope === "personal" && g.permissions.includes("repository.manage")).map(g => g.scope === "personal" ? and(eq(repositories.ownerId, g.actorId), eq(repositories.ownerType, "human"), inArray(repositories.visibility, ["private", "restricted"])) : sql`false`),
    ) ?? sql`false`;
    const repositoryIds = db.select({ id: repositories.id }).from(repositories).where(and(repositoryPredicate(authority), catalogManagement));
    const tiIds = visibleTiRuns(db, authority);
    const configIds = db.select({ id: tiAgentModelConfigs.id }).from(tiAgentModelConfigs).where(resourcePredicate(authority, { projectId: sql`NULL`, personalOwnerId: tiAgentModelConfigs.ownerId, personalOwnerType: tiAgentModelConfigs.ownerType }));
    const scheduleIds = db.select({ id: schedules.id }).from(schedules).where(schedulePredicate(authority));
    const policyIds = db.select({ id: tiAgentPolicies.id }).from(tiAgentPolicies).where(resourcePredicate(authority, { projectId: sql`NULL`, personalOwnerId: tiAgentPolicies.ownerId, personalOwnerType: tiAgentPolicies.ownerType }));
    call[2] = or(...[
      ["project", projectIds], ["requirement", reqIds], ["task", taskIds], ["document", docIds], ["repository", repositoryIds], ["ti_agent_run", tiIds], ["schedule", scheduleIds], ["ti_agent_model_config", configIds], ["ti_agent_policy", policyIds],
    ].map(([kind, ids]) => and(eq(activityLog.entityType, kind as any), inArray(activityLog.entityId, ids as any))));
    return;
  }
  if (group === "usage") {
    if (name === "reportDaemonUsage") {
      const input = call[1];
      if (!input.runId || input.workerIndex === undefined) throw new AuthorizationError();
      const { daemon, requirement } = await requireDaemonLease(db, authority, input.requirementId, input);
      if (requirement.projectId !== input.projectId || daemon.role === "merger" || (daemon.role === "reviewer" ? input.phase !== "review" : !["execution", "rework"].includes(input.phase))) throw new AuthorizationError();
      return;
    }
    if (!["listUsage", "summarizeUsage", "getUsage"].includes(name)) throw new AuthorizationError();
    const input = name === "getUsage" ? { projectId: call[1] } : call[1];
    await requireResource(db, authority, "project", input.projectId, "audit.read");
    if (input.requirementId) {
      const requirement = await requireResource(db, authority, "requirement", input.requirementId, "audit.read");
      if (requirement.projectId !== input.projectId) throw new ValidationError("Usage requirement must belong to the selected project");
    }
    if (input.taskId) {
      const task = await requireResource(db, authority, "task", input.taskId, "audit.read");
      const [stored] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
      if (task.projectId !== input.projectId || (input.requirementId && stored?.requirementId !== input.requirementId)) throw new ValidationError("Usage task must belong to the selected scope");
    }
    call[name === "getUsage" ? 3 : 2] = usageRelationPredicate();
    return;
  }
  const projectPolicy = ["getProjectReviewPolicy", "upsertProjectReviewPolicy"].includes(name);
  const requirementPolicy = ["getEffectiveReviewPolicy", "upsertRequirementReviewPolicy"].includes(name);
  if (projectPolicy || requirementPolicy) {
    await requireResource(db, authority, projectPolicy ? "project" : "requirement", call[1], name.startsWith("upsert") ? "project.manage" : "resource.read");
    return;
  }
  if (name === "listRequirementReviewRuns") {
    await requireResource(db, authority, "requirement", call[1]);
    // Quarantine poisoned delivery relations before LIMIT, not after serialization.
    const valid = db.select({ id: reviewRuns.id }).from(reviewRuns)
      .innerJoin(requirementRepositories, and(eq(requirementRepositories.id, reviewRuns.requirementRepositoryId), eq(requirementRepositories.requirementId, reviewRuns.requirementId)))
      .innerJoin(repositories, eq(repositories.id, requirementRepositories.repositoryId))
      .where(and(eq(reviewRuns.requirementId, call[1]), repositoryPredicate(authority)));
    call[3] = inArray(reviewRuns.id, valid);
    return;
  }
  if (name === "startReviewRun") {
    await requireResource(db, authority, "requirement", call[1], "execution.review");
    const input = { ...call[2] };
    const [link] = await db.select().from(requirementRepositories).where(and(eq(requirementRepositories.id, input.requirementRepositoryId), eq(requirementRepositories.requirementId, call[1]))).limit(1);
    if (!link) throw new NotFoundError("Resource not found");
    await requireRepository(db, authority, link.repositoryId);
    for (const key of ["executorActorId", "executorActorType", "executorDaemonId"] as const) {
      if (input[key] !== undefined && input[key] !== link[key]) throw new AuthorizationError();
      input[key] = link[key];
    }
    if (input.headCommit !== link.headCommit) throw new ValidationError("Review must use the current delivery head");
    if (input.daemonId !== undefined) {
      const { claim } = await requireDaemonLease(db, authority, call[1], input, "reviewer");
      call[4] = { runId: claim.id, generation: claim.generation };
    } else if (authority.actor.type !== "human") throw new AuthorizationError();
    call[2] = input;
    return;
  }
  if (["getReviewRun", "upsertReviewCheck", "upsertReviewFinding", "recordReviewDecision", "evaluateReviewRun"].includes(name)) {
    const [run] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, call[1])).limit(1);
    if (!run) throw new NotFoundError("Resource not found");
    await requireResource(db, authority, "requirement", run.requirementId, name === "getReviewRun" ? "resource.read" : "execution.review");
    const [link] = await db.select().from(requirementRepositories).where(and(eq(requirementRepositories.id, run.requirementRepositoryId), eq(requirementRepositories.requirementId, run.requirementId))).limit(1);
    if (!link) throw new NotFoundError("Resource not found");
    await requireRepository(db, authority, link.repositoryId);
    if (name !== "getReviewRun") {
      if (link.headCommit !== run.headCommit) throw new ValidationError("Review delivery head has changed");
      if (name === "evaluateReviewRun" && (call[2]?.mergerActorId !== undefined || call[2]?.mergerActorType !== undefined || call[2]?.mergerDaemonId !== undefined || call[2]?.mergeMode !== undefined)) throw new AuthorizationError();
      if (run.reviewerDaemonId) {
        const { claim } = await requireDaemonLease(db, authority, run.requirementId, call[2] ?? {}, "reviewer");
        if (run.reviewerDaemonId !== call[2]?.daemonId || run.leaseRunId !== claim.id || run.leaseGeneration !== claim.generation) throw new AuthorizationError();
      } else if (call[2]?.daemonId !== undefined || authority.actor.type !== "human") throw new AuthorizationError();
      if (run.reviewerActorId !== authority.actor.id || run.reviewerActorType !== authority.actor.type) throw new AuthorizationError();
    }
    return;
  }
  throw new AuthorizationError();
}

export function schedulePredicate(authority: ResourceAuthority) {
  return and(resourcePredicate(authority, schedules), sql`(
    (${schedules.targetScope} = 'personal' AND ${schedules.projectId} IS NULL AND ${schedules.requirementId} IS NULL AND ${schedules.personalOwnerType} = 'human')
    OR (${schedules.targetScope} = 'project' AND ${schedules.projectId} IS NOT NULL AND ${schedules.personalOwnerId} IS NULL AND ${schedules.personalOwnerType} IS NULL AND EXISTS (SELECT 1 FROM requirements r WHERE r.id = ${schedules.requirementId} AND r.project_id = ${schedules.projectId}))
  ) AND NOT EXISTS (SELECT 1 FROM schedule_runs sr JOIN tasks t ON t.id = sr.generated_task_id WHERE sr.schedule_id = ${schedules.id} AND NOT (
    (t.scope = 'project' AND t.project_id = ${schedules.projectId} AND t.requirement_id = ${schedules.requirementId} AND t.personal_owner_id IS NULL AND t.personal_owner_type IS NULL AND (t.execution_slice_id IS NULL OR EXISTS (SELECT 1 FROM execution_slices xs WHERE xs.id = t.execution_slice_id AND xs.requirement_id = t.requirement_id)) AND ${schedules.targetScope} = 'project')
    OR (t.scope = 'personal' AND t.project_id IS NULL AND t.requirement_id IS NULL AND t.execution_slice_id IS NULL AND t.personal_owner_id = ${schedules.personalOwnerId} AND t.personal_owner_type = ${schedules.personalOwnerType} AND ${schedules.targetScope} = 'personal')
  ))`);
}

async function authorizeScheduleInput(db: Database, authority: ResourceAuthority, input: any) {
  if (input.targetScope === "personal") {
    if (input.projectId || input.requirementId) throw new ValidationError("Personal schedules cannot belong to a project or requirement");
    input.personalOwnerId ??= authority.actor.type === "human" ? authority.actor.id : authority.actor.managedByActorId;
    input.personalOwnerType ??= "human";
    requireScope(authority, input);
    if ((await loadActivePrincipal(db, input.personalOwnerId)).type !== "human") throw new AuthorizationError();
  } else {
    if (!input.projectId || !input.requirementId || input.personalOwnerId || input.personalOwnerType) throw new ValidationError("Project schedules require a matching project and requirement");
    await requireResource(db, authority, "project", input.projectId, "project.manage");
    const requirement = await requireResource(db, authority, "requirement", input.requirementId);
    if (requirement.projectId !== input.projectId) throw new ValidationError("Schedule requirement must belong to the same project");
  }
  await validateAssignee(db, authority, input, input.assignedExecutor, input.assignedExecutorType);
  if (input.autoRun) {
    if (!input.projectId) throw new AuthorizationError();
    requireScope(authority, input, "execution.run");
  }
  return input;
}

function visibleTiRuns(db: Database, authority: ResourceAuthority) {
  const visibleTasks = db.select({ id: tasks.id }).from(tasks).where(taskResourcePredicate(authority));
  const visibleSchedules = db.select({ id: schedules.id }).from(schedules).where(schedulePredicate(authority));
  const validScheduleRuns = db.select({ id: scheduleRuns.id }).from(scheduleRuns).where(inArray(scheduleRuns.scheduleId, visibleSchedules));
  return db.select({ id: tiAgentRuns.id }).from(tiAgentRuns).where(and(
    or(and(inArray(tiAgentRuns.taskId, visibleTasks), sql`${tiAgentRuns.scheduleRunId} IS NULL`), and(inArray(tiAgentRuns.scheduleRunId, validScheduleRuns), or(sql`${tiAgentRuns.taskId} IS NULL`, and(inArray(tiAgentRuns.taskId, visibleTasks), sql`EXISTS (SELECT 1 FROM schedule_runs sr WHERE sr.id = ${tiAgentRuns.scheduleRunId} AND sr.generated_task_id = ${tiAgentRuns.taskId})`))))
  ));
}
