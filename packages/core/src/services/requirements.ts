import { RequirementCompletionError } from "@task-weaver/contracts";
import type { RetrievalPredicates } from "./retrieval-predicates";
import type { SQL } from "drizzle-orm";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  type Database,
  requirements,
  projects,
  documents,
  repositories,
  executionSlices,
  requirementClaims,
  daemons,
  requirementDependencies,
  tasks,
  taskComments,
  activityLog,
  documentRequirementLinks,
  requirementRepositories,
  workflowOutputs,
  workflowInputs,
} from "@task-weaver/db";
import type { Actor, AddWorkflowInputInput, AdvanceWorkflowStageInput, RegisterWorkflowOutputInput, ReportWorkflowOutputAvailabilityInput } from "@task-weaver/contracts";
import type {
  CreateRequirementInput,
  UpdateRequirementInput,
  ListRequirementsInput,
  BatchCreateRequirementsInput,
  CreateExecutionSliceInput,
  UpdateExecutionSliceInput,
} from "@task-weaver/contracts";
import { emit } from "@task-weaver/realtime";
import { assertRequirementLease } from "./claims";
import {
  assertRequirementStatusTransition,
  requirementStatePolicy,
} from "./daemon-state-machine";
import { ConflictError, NotFoundError, ValidationError } from "@task-weaver/contracts";
import { BASIC_WORKFLOW, requirementWorkflowSchema, workflowFromPreset, type RequirementWorkflow, type WorkflowPreset } from "@task-weaver/contracts";

function selectedWorkflow(input: { workflow?: RequirementWorkflow; workflowPreset?: WorkflowPreset }, projectDefault: Record<string, unknown> | null): { workflow: RequirementWorkflow; source: "basic" | "project" | "explicit" } {
  if (input.workflow && input.workflowPreset) throw new ValidationError("Specify either a workflow or a workflow preset");
  if (input.workflow) return { workflow: input.workflow, source: "explicit" };
  if (input.workflowPreset) return { workflow: workflowFromPreset(input.workflowPreset), source: "explicit" };
  if (projectDefault) return { workflow: requirementWorkflowSchema.parse(projectDefault), source: "project" };
  return { workflow: BASIC_WORKFLOW, source: "basic" };
}
import { assertExecutionSliceCanAdvance } from "./execution-slice-policy";

export async function createRequirement(
  db: Database,
  input: CreateRequirementInput,
  actor: Actor,
) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
  if (!project) throw new NotFoundError("Project not found");
  if (["in_review", "ready_to_merge", "done"].includes(input.status ?? "draft")) throw new ValidationError("New requirements must start before acceptance");
  const resolved = selectedWorkflow(input, project.defaultWorkflow);
  const [requirement] = await db
    .insert(requirements)
    .values({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      modelTier: input.modelTier,
      tags: input.tags,
      branchName: input.branchName,
      workflow: resolved.workflow,
      workflowSource: resolved.source,
      workflowRevision: 1,
      workflowState: { delivery: "pending", acceptance: "pending", integration: "pending" },
      expectedAt: input.expectedAt,
      createdBy: actor.id,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirement!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
  });

  emit({ type: "requirement_created", projectId: input.projectId, requirementId: requirement!.id, title: input.title });

  return requirement!;
}

export async function getRequirement(db: Database, id: string) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, id),
    with: {
      project: true,
      tasks: { with: { repositories: { with: { repository: true } } } },
      executionSlices: {
        with: { tasks: true },
        orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
      },
      dependencies: { with: { dependsOn: true } },
      dependents: { with: { requirement: true } },
      documentLinks: {
        with: { document: true },
      },
      repositories: { with: { repository: true } },
      workflowOutputs: true,
      workflowInputs: { with: { output: true } },
    },
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return requirement;
}

export async function listWorkflowOutputs(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);
  return db.query.workflowOutputs.findMany({
    where: eq(workflowOutputs.requirementId, requirementId),
    orderBy: (output, { asc }) => [asc(output.createdAt)],
  });
}

export async function listWorkflowInputs(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);
  return db.query.workflowInputs.findMany({ where: eq(workflowInputs.requirementId, requirementId), with: { output: true } });
}

export async function getWorkflowCleanupEligibility(db: Database, requirementId: string) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  const workflow = requirement.workflow ? requirementWorkflowSchema.parse(requirement.workflow) : null;
  const outputs = await db.query.workflowOutputs.findMany({ where: eq(workflowOutputs.requirementId, requirementId) });
  const consumers = outputs.length ? await db.query.workflowInputs.findMany({ where: inArray(workflowInputs.outputId, outputs.map((output) => output.id)), with: { requirement: true, task: true, executionSlice: true } }) : [];
  const activeConsumers = consumers.filter((consumer) => !["done", "cancelled", "archived"].includes(consumer.task?.status ?? consumer.executionSlice?.status ?? consumer.requirement.status)).length;
  const terminal = ["done", "cancelled", "archived"].includes(requirement.status);
  const retainUntil = new Date(requirement.updatedAt.getTime() + (workflow?.worktreeRetentionDays ?? 7) * 86_400_000);
  return { terminal, activeConsumers, worktreeRetainUntil: retainUntil, canCleanupWorktrees: terminal && activeConsumers === 0 && retainUntil <= new Date() };
}

export async function retireWorkflowOutput(db: Database, requirementId: string, outputId: string, actor: Actor) {
  const policy = await getWorkflowCleanupEligibility(db, requirementId);
  const output = await db.query.workflowOutputs.findFirst({ where: and(eq(workflowOutputs.id, outputId), eq(workflowOutputs.requirementId, requirementId)) });
  if (!output) throw new NotFoundError("Output not found");
  if (!policy.terminal || policy.activeConsumers > 0) throw new ValidationError("Output is still required by active work");
  if (output.retainUntil && output.retainUntil > new Date()) throw new ValidationError("Output retention period has not expired");
  const [retired] = await db.update(workflowOutputs).set({ availability: "retired" }).where(eq(workflowOutputs.id, output.id)).returning();
  await db.insert(activityLog).values({ entityType: "requirement", entityId: requirementId, action: "workflow_output_retired", actorId: actor.id, actorType: actor.type, metadata: { outputId } });
  return retired!;
}

export async function addWorkflowInput(db: Database, requirementId: string, input: AddWorkflowInputInput, actor: Actor) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  if (!requirement.workflow) throw new ValidationError("Workflow inputs require a configured workflow");
  await assertRequirementLease(db, requirementId, actor, input);
  if (["done", "cancelled", "archived"].includes(requirement.status)) throw new ValidationError("Requirement is terminal");
  const output = await db.query.workflowOutputs.findFirst({ where: eq(workflowOutputs.id, input.outputId) });
  const source = output && await getRequirementOrThrow(db, output.requirementId);
  if (!source || source.projectId !== requirement.projectId) throw new ValidationError("Workflow input must belong to the same project");
  if (output?.availability !== "available") throw new ValidationError("Workflow input output is unavailable");
  if (input.taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
    if (task?.requirementId !== requirementId || task.status !== "todo") throw new ValidationError("Workflow input task must be unstarted and belong to the requirement");
  }
  if (input.executionSliceId) {
    const slice = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, input.executionSliceId) });
    if (slice?.requirementId !== requirementId || slice.status !== "todo") throw new ValidationError("Workflow input slice must be unstarted and belong to the requirement");
  }
  const [registered] = await db.insert(workflowInputs).values({ requirementId, outputId: input.outputId, taskId: input.taskId, executionSliceId: input.executionSliceId, createdBy: actor.id }).returning();
  await db.insert(activityLog).values({ entityType: "requirement", entityId: requirementId, action: "workflow_input_registered", actorId: actor.id, actorType: actor.type, metadata: { outputId: input.outputId, taskId: input.taskId ?? null, executionSliceId: input.executionSliceId ?? null } });
  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });
  return registered!;
}

export async function reportWorkflowOutputAvailability(db: Database, requirementId: string, input: ReportWorkflowOutputAvailabilityInput, actor: Actor) {
  const output = await db.query.workflowOutputs.findFirst({ where: and(eq(workflowOutputs.id, input.outputId), eq(workflowOutputs.requirementId, requirementId)) });
  if (!output || output.type !== "local" || output.nodeId !== input.nodeId) throw new ValidationError("Local output node does not match");
  if (output.availability === "retired") throw new ValidationError("Retired outputs cannot be made available again");
  if (actor.type === "agent") {
    const daemon = input.daemonId && await db.query.daemons.findFirst({ where: eq(daemons.id, input.daemonId) });
    if (!daemon || daemon.nodeId !== input.nodeId || daemon.actorId !== actor.id || daemon.actorType !== actor.type) throw new ValidationError("Availability reports require the registered producing node");
  }
  const [updated] = await db.update(workflowOutputs).set({ availability: input.availability, verifiedAt: new Date() }).where(eq(workflowOutputs.id, input.outputId)).returning();
  await db.insert(activityLog).values({ entityType: "requirement", entityId: requirementId, action: "workflow_output_probed", actorId: actor.id, actorType: actor.type, metadata: { outputId: input.outputId, availability: input.availability, reason: input.reason } });
  return updated!;
}

export async function registerWorkflowOutput(
  db: Database,
  requirementId: string,
  input: RegisterWorkflowOutputInput,
  actor: Actor,
) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  if (!requirement.workflow) throw new ValidationError("Legacy requirements do not use workflow outputs");
  await assertRequirementLease(db, requirementId, actor, input);
  if (["done", "cancelled", "archived"].includes(requirement.status)) throw new ValidationError("Requirement is terminal");
  const workflow = requirementWorkflowSchema.parse(requirement.workflow);
  if (["complete", "skipped"].includes(requirement.workflowState?.acceptance ?? "pending")) throw new ValidationError("Accepted delivery outputs are frozen");
  if (input.taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
    if (task?.requirementId !== requirementId) throw new ValidationError("Output task does not belong to the requirement");
  }
  if (input.executionSliceId) {
    const slice = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, input.executionSliceId) });
    if (slice?.requirementId !== requirementId) throw new ValidationError("Output slice does not belong to the requirement");
  }
  if (input.requirementRepositoryId) {
    const link = await db.query.requirementRepositories.findFirst({ where: eq(requirementRepositories.id, input.requirementRepositoryId) });
    if (link?.requirementId !== requirementId) throw new ValidationError("Output repository does not belong to the requirement");
  }
  if (input.type === "comment") {
    const comment = await db.query.taskComments.findFirst({ where: eq(taskComments.id, input.referenceId!) });
    const task = comment && await db.query.tasks.findFirst({ where: eq(tasks.id, comment.taskId) });
    if (task?.requirementId !== requirementId) throw new ValidationError("Comment does not belong to the requirement");
  }
  if (input.type === "attachment") {
    const document = await db.query.documents.findFirst({ where: eq(documents.id, input.referenceId!) });
    if (document?.form !== "attachment" || document.projectId !== requirement.projectId) throw new ValidationError("Attachment does not belong to the project");
  }
  if (input.type === "local") {
    const claim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirementId) });
    if (claim?.daemonId) {
      const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, claim.daemonId) });
      if (!daemon?.nodeId || daemon.nodeId !== input.nodeId) throw new ValidationError("Local output must be registered from the active daemon node");
    }
  }
  if ((input.type === "git_branch" || input.type === "git_pr") && !input.requirementRepositoryId) {
    throw new ValidationError("Git output requires a linked repository");
  }
  const gitLink = input.requirementRepositoryId && await db.query.requirementRepositories.findFirst({ where: eq(requirementRepositories.id, input.requirementRepositoryId) });
  if (["git_branch", "git_pr"].includes(input.type) && gitLink && gitLink.deliveryStatus !== "unchanged" && (!gitLink.pushedCommit || (input.type === "git_pr" && !gitLink.pullRequestUrl))) throw new ValidationError("Repository has no verified delivery for this output type");
  const [revision] = await db.update(requirements).set({ workflowStateRevision: requirement.workflowStateRevision + 1, updatedAt: new Date() })
    .where(and(eq(requirements.id, requirementId), eq(requirements.workflowStateRevision, requirement.workflowStateRevision))).returning({ id: requirements.id });
  if (!revision) throw new ConflictError("Workflow state changed", requirement.workflowStateRevision);
  const [output] = await db.insert(workflowOutputs).values({
    requirementId, taskId: input.taskId, executionSliceId: input.executionSliceId,
    workflowRevision: requirement.workflowRevision,
    requirementRepositoryId: input.requirementRepositoryId, type: input.type,
    referenceId: input.referenceId, url: input.url, nodeId: input.nodeId,
    relativePath: input.relativePath, sizeBytes: input.sizeBytes, sha256: input.sha256,
    headCommit: gitLink ? gitLink.pushedCommit ?? gitLink.headCommit : null,
    summary: input.summary, createdBy: actor.id, createdByType: actor.type,
    verifiedAt: input.type === "local" ? new Date() : undefined,
    retainUntil: input.type === "local" ? new Date(Date.now() + workflow.localArtifactRetentionDays * 86_400_000) : undefined,
  }).returning();
  await db.insert(activityLog).values({
    entityType: "requirement", entityId: requirementId, action: "workflow_output_registered",
    actorId: actor.id, actorType: actor.type,
    metadata: { outputId: output!.id, type: input.type, nodeId: input.nodeId ?? null },
  });
  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });
  return output!;
}

export async function advanceWorkflowStage(
  db: Database,
  requirementId: string,
  input: AdvanceWorkflowStageInput,
  actor: Actor,
) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  if (!requirement.workflow) throw new ValidationError("Legacy requirements do not use workflow stages");
  if (["done", "cancelled", "archived"].includes(requirement.status)) throw new ValidationError("Requirement is terminal");
  if (requirement.workflowStateRevision !== input.expectedRevision) throw new ConflictError("Workflow state changed", requirement.workflowStateRevision);
  await assertRequirementLease(db, requirementId, actor, input);
  const workflow = requirementWorkflowSchema.parse(requirement.workflow);
  const state = { delivery: "pending", acceptance: "pending", integration: "pending", ...requirement.workflowState };
  if (input.decision === "complete") {
    const dependencies = await db.query.requirementDependencies.findMany({ where: and(eq(requirementDependencies.requirementId, requirementId), eq(requirementDependencies.type, "blocks")), with: { dependsOn: true } });
    if (dependencies.some((dependency) => !["done", "cancelled"].includes(dependency.dependsOn.status))) throw new ValidationError("Requirement dependencies are incomplete");
  }
  const order = ["delivery", "acceptance", "integration"] as const;
  const stageIndex = order.indexOf(input.stage);
  if (order.slice(0, stageIndex).some((stage) => state[stage] !== "complete" && state[stage] !== "skipped")) {
    throw new ValidationError("Previous workflow stages are incomplete");
  }
  const resubmittingAfterFeedback = input.stage === "delivery" && state.acceptance === "failed";
  if ((state[input.stage] === "complete" || state[input.stage] === "skipped") && !resubmittingAfterFeedback) throw new ValidationError("Workflow stage is already terminal");
  if (workflow[input.stage].mode === "skip" && input.stage !== "delivery") throw new ValidationError("Skipped stages advance automatically");
  if (workflow[input.stage].mode === "manual" && actor.type !== "human") throw new ValidationError("This stage requires a human decision");
  if (input.decision === "complete" && input.stage === "delivery") {
    const openTasks = await db.query.tasks.findMany({ where: eq(tasks.requirementId, requirementId) });
    if (openTasks.some((task) => task.status !== "done" && task.status !== "cancelled")) throw new ValidationError("Requirement tasks are incomplete");
    if (workflow.delivery.method !== "none") {
      const outputs = await db.query.workflowOutputs.findMany({ where: and(eq(workflowOutputs.requirementId, requirementId), eq(workflowOutputs.workflowRevision, requirement.workflowRevision), eq(workflowOutputs.availability, "available")) });
      if (!["git_branch", "git_pr"].includes(workflow.delivery.method) && !outputs.some((output) => output.type === workflow.delivery.method)) throw new ValidationError("Required delivery output is missing");
      if (["git_branch", "git_pr"].includes(workflow.delivery.method)) {
        const links = await db.query.requirementRepositories.findMany({ where: eq(requirementRepositories.requirementId, requirementId) });
        if (workflow.integration.target && ["git_provider", "git_direct"].includes(workflow.integration.method) && links.some((link) => link.baseBranch !== workflow.integration.target)) throw new ValidationError("Git integration target must match the repository base branch");
        if (!links.length || links.some((link) => link.deliveryStatus !== "unchanged" && (!link.pushedCommit || !outputs.some((output) => output.requirementRepositoryId === link.id && output.type === workflow.delivery.method && output.headCommit === link.pushedCommit) || (workflow.delivery.method === "git_pr" && !link.pullRequestUrl)))) throw new ValidationError("Git delivery evidence is incomplete");
      }
    }
  }
  if (input.decision === "complete" && input.stage === "acceptance") {
    const checks = new Map(input.checks.map((check) => [check.name, check.status]));
    if (workflow.acceptance.requiredChecks.some((name) => checks.get(name) !== "passed")) throw new ValidationError("Required acceptance checks have not passed");
    if (workflow.acceptance.minimumHumanApprovals > 0 && actor.type !== "human") throw new ValidationError("Human acceptance is required");
  }
  if (input.decision === "complete" && input.stage === "integration" && ["git_provider", "git_direct"].includes(workflow.integration.method)) {
    const links = await db.query.requirementRepositories.findMany({ where: eq(requirementRepositories.requirementId, requirementId) });
    if (links.length === 0 || links.some((link) => link.deliveryStatus !== "merged" && link.deliveryStatus !== "unchanged")) {
      throw new ValidationError("Repository integration evidence is incomplete");
    }
  }
  state[input.stage] = input.decision === "complete"
    ? workflow[input.stage].mode === "skip" ? "skipped" : "complete"
    : "failed";
  if (input.decision === "retry") {
    if (actor.type !== "human" || requirement.workflowState?.[input.stage] !== "failed") throw new ValidationError("Only a human can retry a failed stage");
    state[input.stage] = "pending";
  }
  if (input.stage === "integration" && input.decision === "changes_requested") {
    state.delivery = "pending";
    state.acceptance = "pending";
    state.integration = "pending";
  }
  if (resubmittingAfterFeedback && input.decision === "complete") {
    state.acceptance = "pending";
    state.integration = "pending";
  }
  if (input.decision === "complete") {
    for (const stage of order.slice(stageIndex + 1)) {
      if (workflow[stage].mode === "skip") state[stage] = "skipped";
      else break;
    }
  }
  const nextStatus = input.decision !== "complete"
    ? input.decision === "changes_requested" ? "in_progress" : input.stage === "integration" ? "ready_to_merge" : input.stage === "acceptance" ? "in_review" : "in_progress"
    : order.every((stage) => state[stage] === "complete" || state[stage] === "skipped")
      ? "done"
      : state.acceptance === "complete" || state.acceptance === "skipped"
        ? "ready_to_merge"
        : "in_review";
  const [updated] = await db.update(requirements).set({
    workflowState: state,
    workflowStateRevision: requirement.workflowStateRevision + 1,
    status: nextStatus,
    updatedAt: new Date(),
  }).where(and(eq(requirements.id, requirementId), eq(requirements.workflowStateRevision, input.expectedRevision))).returning();
  if (!updated) throw new ConflictError("Workflow state changed", requirement.workflowStateRevision);
  if (nextStatus === "done") await db.delete(requirementClaims).where(eq(requirementClaims.requirementId, requirementId));
  if (input.decision === "changes_requested") {
    await db.insert(tasks).values({
      projectId: requirement.projectId,
      requirementId,
      title: `Address ${input.stage} feedback`,
      description: input.reason,
      status: "todo",
      createdBy: actor.id,
    });
  }
  await db.insert(activityLog).values({
    entityType: "requirement", entityId: requirementId, action: "workflow_stage_advanced",
    actorId: actor.id, actorType: actor.type,
    metadata: { stage: input.stage, decision: input.decision, reason: input.reason, checks: input.checks, workflowRevision: requirement.workflowRevision, from: requirement.workflowState, to: state, status: nextStatus },
  });
  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });
  return updated;
}

const TERMINAL_REQ_STATUSES = ["done", "cancelled", "archived"] as const;
const DEFAULT_REQ_COMPLETED_WITHIN_DAYS = 14;

type PagedRequirementList = {
  items: unknown[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  view: "summary" | "full"
}
type RequirementListItem = typeof requirements.$inferSelect & {
  tasks: Array<typeof tasks.$inferSelect>
  dependencies: Array<typeof requirementDependencies.$inferSelect & { dependsOn: typeof requirements.$inferSelect }>
  dependents: Array<typeof requirementDependencies.$inferSelect & { requirement: typeof requirements.$inferSelect }>
  repositories: Array<typeof requirementRepositories.$inferSelect & { repository: typeof repositories.$inferSelect }>
}
type LegacyRequirementList = RequirementListItem[]


export function listRequirements(
  db: Database,
  input: ListRequirementsInput & { view: "summary" | "full" },
  authorizedPredicate?: SQL,
): Promise<PagedRequirementList>

export function listRequirements(
  db: Database,
  input: ListRequirementsInput,
  authorizedPredicate?: SQL,
): Promise<LegacyRequirementList>

export async function listRequirements(
  db: Database,
  input: ListRequirementsInput,
  authorizedPredicate?: SQL,
): Promise<PagedRequirementList | LegacyRequirementList> {
  const conditions = [eq(requirements.projectId, input.projectId), authorizedPredicate];

  if (input.status) {
    conditions.push(eq(requirements.status, input.status));
  }
  if (input.priority) {
    conditions.push(eq(requirements.priority, input.priority));
  }
  if (input.tag) {
    conditions.push(sql`${input.tag} = ANY(${requirements.tags})`);
  }
  if (input.query) {
    const pattern = `%${input.query}%`;
    conditions.push(sql`(
      ${requirements.title} ILIKE ${pattern}
      OR COALESCE(${requirements.description}, '') ILIKE ${pattern}
    )`);
  }

  const isExplicitTerminalFilter =
    input.status !== undefined &&
    TERMINAL_REQ_STATUSES.includes(input.status as (typeof TERMINAL_REQ_STATUSES)[number]);

  if (!isExplicitTerminalFilter) {
    const days = input.completedWithinDays ?? DEFAULT_REQ_COMPLETED_WITHIN_DAYS;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      conditions.push(
        sql`(${requirements.status} NOT IN ('done', 'cancelled', 'archived') OR ${requirements.updatedAt} >= ${cutoff.toISOString()})`,
      );
    }
  }

  const where = and(...conditions);
  if (input.view === undefined) {
    return db.query.requirements.findMany({
      where,
      with: {
        tasks: {
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        },
        dependencies: { with: { dependsOn: true } },
        dependents: { with: { requirement: true } },
        repositories: { with: { repository: true } },
      },
      orderBy: (r, { desc }) => [desc(r.updatedAt)],
    });
  }

  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? (input.view === "full" ? 5 : 20);
  const offset = (page - 1) * pageSize;
  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(requirements)
    .where(where);

  if (input.view === "summary") {
    const [items, totalRows] = await Promise.all([
      db.query.requirements.findMany({
        where,
        columns: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          priority: true,
          modelTier: true,
          branchName: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: (r, { desc }) => [desc(r.updatedAt)],
        limit: pageSize,
        offset,
      }),
      totalQuery,
    ]);
    const total = totalRows[0]?.count ?? 0;
    return {
      items,
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
      view: "summary" as const,
    };
  }

  const [items, totalRows] = await Promise.all([
    db.query.requirements.findMany({
      where,
      with: {
        tasks: {
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        },
        dependencies: { with: { dependsOn: true } },
        dependents: { with: { requirement: true } },
        repositories: { with: { repository: true } },
      },
      orderBy: (r, { desc }) => [desc(r.updatedAt)],
      limit: pageSize,
      offset,
    }),
    totalQuery,
  ]);
  const total = totalRows[0]?.count ?? 0;
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
    view: "full" as const,
  };
}


export async function updateRequirement(
  db: Database,
  id: string,
  input: UpdateRequirementInput,
  actor: Actor,
) {
  const existing = await getRequirementOrThrow(db, id);
  const { leaseGeneration, daemonId, workflow, workflowPreset, ...fields } = input;

  if (input.status || leaseGeneration !== undefined || daemonId !== undefined) {
    await assertRequirementLease(db, id, actor, { leaseGeneration, daemonId });
  }

  if (existing.status === "cancelled") {
    throw new ValidationError("Cannot update a cancelled requirement");
  }
  if (input.status) {
    assertRequirementStatusTransition(existing.status, input.status);
    if (existing.workflow && ["in_review", "ready_to_merge", "done"].includes(input.status)) {
      const state = existing.workflowState ?? {};
      if (state.delivery !== "complete" && state.delivery !== "skipped") throw new RequirementCompletionError("requirement_workflow_incomplete");
      if (["ready_to_merge", "done"].includes(input.status) && state.acceptance !== "complete" && state.acceptance !== "skipped") throw new RequirementCompletionError("requirement_workflow_incomplete");
      if (input.status === "done" && state.integration !== "complete" && state.integration !== "skipped") throw new RequirementCompletionError("requirement_workflow_incomplete");
    }
  }
  let workflowChanges: Record<string, unknown> = {};
  if (workflow || workflowPreset) {
    await assertRequirementLease(db, id, actor, { leaseGeneration, daemonId });
    if (workflow && workflowPreset) throw new ValidationError("Specify either a workflow or a workflow preset");
    if (!["draft", "approved"].includes(existing.status)) throw new ValidationError("Workflow changes require a draft or approved requirement");
    const activeTasks = await db.query.tasks.findMany({ where: eq(tasks.requirementId, id) });
    if (activeTasks.some((task) => task.status !== "todo")) throw new ValidationError("Workflow changes require all tasks to be unstarted");
    workflowChanges = {
      workflow: workflow ?? workflowFromPreset(workflowPreset!),
      workflowSource: "explicit",
      workflowRevision: existing.workflowRevision + 1,
      workflowState: { delivery: "pending", acceptance: "pending", integration: "pending" },
      workflowStateRevision: existing.workflowStateRevision + 1,
    };
  }
  if (input.status === "done") {
    if (existing.workflow) {
      const state = existing.workflowState ?? {};
      if (state.delivery !== "complete" && state.delivery !== "skipped"
        || state.acceptance !== "complete" && state.acceptance !== "skipped"
        || state.integration !== "complete" && state.integration !== "skipped") {
        throw new RequirementCompletionError("requirement_workflow_incomplete");
      }
    } else {
      const repositoryLinks = await db
        .select({ deliveryStatus: requirementRepositories.deliveryStatus })
        .from(requirementRepositories)
        .where(eq(requirementRepositories.requirementId, id));
      const incomplete = repositoryLinks.filter(
        (link) => link.deliveryStatus !== "merged" && link.deliveryStatus !== "unchanged",
      );
      if (incomplete.length > 0) {
        throw new RequirementCompletionError("requirement_repository_delivery_incomplete");
      }
    }
  }

  const [updated] = await db
    .update(requirements)
    .set({ ...fields, ...workflowChanges, updatedAt: new Date() })
    .where(eq(requirements.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: id,
    action: input.status ? "status_changed" : "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      changes: { ...fields, ...workflowChanges },
      previous: {
        title: existing.title,
        status: existing.status,
        priority: existing.priority,
      },
    },
  });

  if (input.status && requirementStatePolicy(input.status).terminal) {
    await db
      .delete(requirementClaims)
      .where(eq(requirementClaims.requirementId, id));
  }

  emit({ type: "requirement_updated", projectId: updated!.projectId, requirementId: id });

  return updated!;
}

export async function deleteRequirement(
  db: Database,
  id: string,
  actor: Actor,
) {
  const existing = await getRequirementOrThrow(db, id);
  assertRequirementStatusTransition(existing.status, "cancelled");

  const [updated] = await db
    .update(requirements)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(requirements.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: id,
    action: "cancelled",
    actorId: actor.id,
    actorType: actor.type,
  });

  await db
    .delete(requirementClaims)
    .where(eq(requirementClaims.requirementId, id));

  emit({ type: "requirement_deleted", projectId: updated!.projectId, requirementId: id });

  return updated!;
}

export async function batchCreateRequirements(
  db: Database,
  input: BatchCreateRequirementsInput,
  actor: Actor,
) {
  const results = await db.transaction(async (tx) => {
    const created = [];
    for (const reqInput of input.requirements) {
      created.push(await createRequirement(tx as unknown as Database, reqInput, actor));
    }
    return created;
  });

  return results;
}

export async function linkDocumentToRequirement(
  db: Database,
  requirementId: string,
  documentId: string,
  linkType: "references" | "documents" | "output",
  actor: Actor,
) {
  await getRequirementOrThrow(db, requirementId);

  const [link] = await db
    .insert(documentRequirementLinks)
    .values({ documentId, requirementId, linkType })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "document_linked",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { documentId, linkType },
  });

  return link!;
}

export async function unlinkDocumentFromRequirement(
  db: Database,
  linkId: string,
  _expectedParentId?: string,
) {
  const [deleted] = await db
    .delete(documentRequirementLinks)
    .where(eq(documentRequirementLinks.id, linkId))
    .returning();
  if (!deleted) throw new NotFoundError("Document-requirement link not found");
  return deleted;
}

export async function listExecutionSlices(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);
  return db.query.executionSlices.findMany({
    where: eq(executionSlices.requirementId, requirementId),
    with: { tasks: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
  });
}

export async function createExecutionSlice(
  db: Database,
  requirementId: string,
  input: CreateExecutionSliceInput,
  actor: Actor,
) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  const orderIndex = input.orderIndex ?? await nextExecutionSliceOrder(db, requirementId);

  const [slice] = await db
    .insert(executionSlices)
    .values({
      requirementId,
      title: input.title,
      description: input.description,
      orderIndex,
      allowParallel: input.allowParallel,
      modelTier: input.modelTier ?? requirement.modelTier,
    })
    .returning();

  if (input.taskIds) {
    await setTasksForExecutionSlice(db, requirementId, slice!.id, input.taskIds);
  }

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "execution_slice_created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      sliceId: slice!.id,
      title: input.title,
      orderIndex,
      allowParallel: input.allowParallel,
    },
  });

  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });

  return getExecutionSlice(db, slice!.id);
}

export async function getExecutionSlice(db: Database, sliceId: string) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, sliceId),
    with: { tasks: true, requirement: true },
  });
  if (!slice) throw new NotFoundError("Execution slice not found");
  return slice;
}

export async function updateExecutionSlice(
  db: Database,
  sliceId: string,
  input: UpdateExecutionSliceInput,
  actor: Actor,
) {
  const existing = await getExecutionSlice(db, sliceId);
  const { taskIds, leaseGeneration, daemonId, ...fields } = input;

  if (input.status || leaseGeneration !== undefined || daemonId !== undefined) {
    await assertRequirementLease(
      db,
      existing.requirementId,
      actor,
      { leaseGeneration, daemonId },
    );
  }

  if (input.status && ["in_progress", "in_review", "done"].includes(input.status)) {
    await assertExecutionSliceCanAdvance(db, sliceId, {
      allowParallel: input.allowParallel ?? existing.allowParallel,
    });
  }

  const updateFields: Record<string, unknown> = { ...fields, updatedAt: new Date() };
  if (input.description === null) updateFields.description = null;
  if (input.resultSummary === null) updateFields.resultSummary = null;

  const [updated] = await db
    .update(executionSlices)
    .set(updateFields)
    .where(eq(executionSlices.id, sliceId))
    .returning();

  if (taskIds) {
    await setTasksForExecutionSlice(db, existing.requirementId, sliceId, taskIds);
  }

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: existing.requirementId,
    action: "execution_slice_updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { sliceId, changes: fields },
  });

  emit({ type: "requirement_updated", projectId: existing.requirement.projectId, requirementId: existing.requirementId });

  return getExecutionSlice(db, updated!.id);
}

export async function deleteExecutionSlice(db: Database, sliceId: string, actor: Actor) {
  const existing = await getExecutionSlice(db, sliceId);

  await db
    .update(tasks)
    .set({ executionSliceId: null, updatedAt: new Date() })
    .where(eq(tasks.executionSliceId, sliceId));

  const [deleted] = await db
    .delete(executionSlices)
    .where(eq(executionSlices.id, sliceId))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: existing.requirementId,
    action: "execution_slice_deleted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { sliceId, title: existing.title },
  });

  emit({ type: "requirement_updated", projectId: existing.requirement.projectId, requirementId: existing.requirementId });

  return deleted!;
}

async function nextExecutionSliceOrder(db: Database, requirementId: string) {
  const rows = await db
    .select({ maxOrder: sql<number>`COALESCE(MAX(${executionSlices.orderIndex}), -1)` })
    .from(executionSlices)
    .where(eq(executionSlices.requirementId, requirementId));
  return Number(rows[0]?.maxOrder ?? -1) + 1;
}

async function setTasksForExecutionSlice(
  db: Database,
  requirementId: string,
  sliceId: string,
  taskIds: string[],
) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, sliceId),
  });
  if (!slice) throw new NotFoundError("Execution slice not found");
  if (slice.requirementId !== requirementId) {
    throw new ValidationError("Execution slice must belong to the requirement");
  }

  if (taskIds.length > 0) {
    const taskRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
    });
    if (taskRows.length !== taskIds.length) {
      throw new NotFoundError("One or more tasks were not found");
    }
    if (taskRows.some((task) => task.requirementId !== requirementId)) {
      throw new ValidationError("All slice tasks must belong to the same requirement");
    }
  }

  await db
    .update(tasks)
    .set({ executionSliceId: null, updatedAt: new Date() })
    .where(eq(tasks.executionSliceId, sliceId));

  if (taskIds.length === 0) return;

  await db
    .update(tasks)
    .set({ executionSliceId: sliceId, updatedAt: new Date() })
    .where(inArray(tasks.id, taskIds));
}

export async function addRequirementDependency(
  db: Database,
  requirementId: string,
  dependsOnRequirementId: string,
  type: "blocks" | "related",
  actor: Actor,
  description?: string,
) {
  const [requirement, dependsOn] = await Promise.all([
    getRequirementOrThrow(db, requirementId),
    getRequirementOrThrow(db, dependsOnRequirementId),
  ]);

  if (requirementId === dependsOnRequirementId) {
    throw new ValidationError("A requirement cannot depend on itself");
  }

  if (requirement.projectId !== dependsOn.projectId) {
    throw new ValidationError("Requirement dependencies must stay within the same project");
  }

  const existingDeps = await db.query.requirementDependencies.findMany({
    where: eq(requirementDependencies.requirementId, requirementId),
  });
  if (
    existingDeps.some(
      (dep) =>
        dep.dependsOnRequirementId === dependsOnRequirementId &&
        dep.type === type,
    )
  ) {
    throw new ValidationError("Requirement dependency already exists");
  }

  if (await wouldCreateRequirementDependencyCycle(db, requirementId, dependsOnRequirementId)) {
    throw new ValidationError("Requirement dependency would create a cycle");
  }

  const [dep] = await db
    .insert(requirementDependencies)
    .values({ requirementId, dependsOnRequirementId, type, description })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "dependency_added",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { dependsOnRequirementId, type, description },
  });

  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });

  return dep!;
}

export async function listRequirementDependencies(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);

  const [dependencies, dependents] = await Promise.all([
    db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.requirementId, requirementId),
      with: { dependsOn: true },
    }),
    db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.dependsOnRequirementId, requirementId),
      with: { requirement: true },
    }),
  ]);

  return { dependencies, dependents };
}

export async function removeRequirementDependency(
  db: Database,
  depId: string,
  actor?: Actor,
  _expectedParentId?: string,
) {
  const [deleted] = await db
    .delete(requirementDependencies)
    .where(eq(requirementDependencies.id, depId))
    .returning();

  if (!deleted) throw new NotFoundError("Requirement dependency not found");

  if (actor) {
    await db.insert(activityLog).values({
      entityType: "requirement",
      entityId: deleted.requirementId,
      action: "dependency_removed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: {
        dependsOnRequirementId: deleted.dependsOnRequirementId,
        type: deleted.type,
      },
    });
  }

  return deleted;
}

export async function checkBlockingRequirementDependencies(
  db: Database,
  requirementId: string,
) {
  const deps = await db.query.requirementDependencies.findMany({
    where: eq(requirementDependencies.requirementId, requirementId),
    with: { dependsOn: true },
  });

  return deps
    .filter((dep: any) =>
      dep.type === "blocks" &&
      dep.dependsOn &&
      dep.dependsOn.status !== "done" &&
      dep.dependsOn.status !== "cancelled"
    )
    .map((dep: any) => ({
      dependencyId: dep.id,
      requirementId: dep.dependsOnRequirementId,
      title: dep.dependsOn.title,
      status: dep.dependsOn.status,
    }));
}

async function wouldCreateRequirementDependencyCycle(
  db: Database,
  requirementId: string,
  dependsOnRequirementId: string,
) {
  const visited = new Set<string>();
  const stack = [dependsOnRequirementId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === requirementId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = await db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.requirementId, current),
    });

    for (const dep of deps) {
      stack.push(dep.dependsOnRequirementId);
    }
  }

  return false;
}

export interface SearchRequirementsInput {
  query: string;
  projectId?: string;
  limit?: number;
}

export async function searchRequirements(
  db: Database,
  input: SearchRequirementsInput,
  authorizedPredicate?: SQL,
) {
  const likePattern = `%${input.query}%`;
  const conditions = [
    sql`(${requirements.title} ILIKE ${likePattern} OR ${requirements.description} ILIKE ${likePattern} OR EXISTS (SELECT 1 FROM unnest(${requirements.tags}) AS t WHERE t ILIKE ${likePattern}))`,
  ];
  if (input.projectId) {
    conditions.push(sql`${requirements.projectId} = ${input.projectId}`);
  }

  return db
    .select({
      id: requirements.id,
      title: requirements.title,
      description: requirements.description,
      status: requirements.status,
      priority: requirements.priority,
      projectId: requirements.projectId,
      tags: requirements.tags,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(...conditions, authorizedPredicate))
    .limit(input.limit ?? 20);
}

export interface BurndownDataPoint {
  date: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
}

export interface RequirementBurndown {
  requirementId: string;
  title: string;
  totalTasks: number;
  completedTasks: number;
  startDate: string;
  endDate: string;
  dataPoints: BurndownDataPoint[];
  idealLine: { date: string; remaining: number }[];
  velocity: number;
  projectedCompletionDate: string | null;
}

export async function getRequirementBurndown(
  db: Database,
  requirementId: string,
  authorizedTaskPredicate?: SQL,
): Promise<RequirementBurndown> {
  const requirement = await getRequirementOrThrow(db, requirementId);

  const taskList = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      createdAt: tasks.createdAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.requirementId, requirementId), authorizedTaskPredicate));

  if (taskList.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      requirementId,
      title: requirement.title,
      totalTasks: 0,
      completedTasks: 0,
      startDate: today,
      endDate: today,
      dataPoints: [],
      idealLine: [],
      velocity: 0,
      projectedCompletionDate: null,
    };
  }

  // Determine date range (use date strings to avoid timezone issues)
  const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const createdDates = taskList.map((t) => t.createdAt);
  const startDate = new Date(Math.min(...createdDates.map((d) => d.getTime())));
  const now = new Date();
  const endDateStr = toDateStr(now);

  // Build daily data points
  const dataPoints: BurndownDataPoint[] = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);

  while (toDateStr(cursor) <= endDateStr) {
    const dateStr = toDateStr(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(23, 59, 59, 999);

    // Tasks that existed by this date
    const existingTasks = taskList.filter((t) => t.createdAt <= dayEnd);
    // Tasks completed by this date
    const completed = existingTasks.filter(
      (t) => t.completedAt && t.completedAt <= dayEnd,
    );

    dataPoints.push({
      date: dateStr,
      totalTasks: existingTasks.length,
      completedTasks: completed.length,
      remainingTasks: existingTasks.length - completed.length,
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  // Build ideal line (linear from total tasks to 0)
  const totalTasks = taskList.length;
  const completedTasks = taskList.filter(
    (t) => t.status === "done" || t.status === "cancelled",
  ).length;

  const idealLine: { date: string; remaining: number }[] = [];
  if (dataPoints.length > 1) {
    const totalDays = dataPoints.length - 1;
    for (let i = 0; i <= totalDays; i++) {
      idealLine.push({
        date: dataPoints[i]!.date,
        remaining: Math.round(totalTasks * (1 - i / totalDays)),
      });
    }
  } else if (dataPoints.length === 1) {
    idealLine.push({ date: dataPoints[0]!.date, remaining: totalTasks });
  }

  // Calculate velocity (tasks completed per day over the last 7 days)
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCompletions = taskList.filter(
    (t) => t.completedAt && t.completedAt >= sevenDaysAgo && t.completedAt <= now,
  ).length;
  const daysSinceStart = Math.max(1, dataPoints.length);
  const effectiveDays = Math.min(7, daysSinceStart);
  const velocity = recentCompletions / effectiveDays;

  // Project completion date
  const remaining = totalTasks - completedTasks;
  let projectedCompletionDate: string | null = null;
  if (remaining > 0 && velocity > 0) {
    const daysToComplete = Math.ceil(remaining / velocity);
    const projected = new Date(now);
    projected.setDate(projected.getDate() + daysToComplete);
    projectedCompletionDate = toDateStr(projected);
  } else if (remaining === 0) {
    projectedCompletionDate = endDateStr;
  }

  return {
    requirementId,
    title: requirement.title,
    totalTasks,
    completedTasks,
    startDate: toDateStr(startDate),
    endDate: endDateStr,
    dataPoints,
    idealLine,
    velocity: Math.round(velocity * 100) / 100,
    projectedCompletionDate,
  };
}

export interface RequirementHeatmapItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  commentCount: number;
  documentLinkCount: number;
  activityCount: number;
  lastActivityAt: string | null;
  daysSinceLastActivity: number | null;
  heatScore: number;
}

export interface RequirementHeatmap {
  projectId: string;
  generatedAt: string;
  requirements: RequirementHeatmapItem[];
  hotspots: RequirementHeatmapItem[];
  coldspots: RequirementHeatmapItem[];
}

export async function getRequirementHeatmap(
  db: Database,
  projectId: string,
  authorized: RetrievalPredicates = {},
): Promise<RequirementHeatmap> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Get all non-cancelled requirements for the project
  const reqList = await db
    .select({
      id: requirements.id,
      title: requirements.title,
      status: requirements.status,
      priority: requirements.priority,
    })
    .from(requirements)
    .where(and(authorized.requirements, eq(requirements.projectId, projectId), sql`${requirements.status} != 'cancelled'`));

  if (reqList.length === 0) {
    return {
      projectId,
      generatedAt: now.toISOString(),
      requirements: [],
      hotspots: [],
      coldspots: [],
    };
  }

  const reqIds = reqList.map((r) => r.id);

  // Task stats per requirement
  const taskStats = await db
    .select({
      requirementId: tasks.requirementId,
      totalTasks: sql<number>`count(*)::int`,
      completedTasks: sql<number>`count(CASE WHEN ${tasks.status} = 'done' THEN 1 END)::int`,
      overdueTasks: sql<number>`count(CASE WHEN ${tasks.expectedAt} < now() AND ${tasks.status} NOT IN ('done', 'cancelled') THEN 1 END)::int`,
    })
    .from(tasks)
    .where(and(inArray(tasks.requirementId, reqIds), authorized.tasks))
    .groupBy(tasks.requirementId);

  const taskStatsMap = new Map(taskStats.map((r) => [r.requirementId, r]));

  // Comment counts per requirement (via tasks)
  const commentStats = await db
    .select({
      requirementId: tasks.requirementId,
      commentCount: sql<number>`count(${taskComments.id})::int`,
    })
    .from(taskComments)
    .innerJoin(tasks, eq(taskComments.taskId, tasks.id))
    .where(and(inArray(tasks.requirementId, reqIds), authorized.tasks))
    .groupBy(tasks.requirementId);

  const commentMap = new Map(commentStats.map((r) => [r.requirementId, r.commentCount]));

  // Document link counts per requirement
  const docLinkStats = await db
    .select({
      requirementId: documentRequirementLinks.requirementId,
      linkCount: sql<number>`count(*)::int`,
    })
    .from(documentRequirementLinks)
    .innerJoin(documents, eq(documents.id, documentRequirementLinks.documentId))
    .where(and(inArray(documentRequirementLinks.requirementId, reqIds), authorized.documents))
    .groupBy(documentRequirementLinks.requirementId);

  const docLinkMap = new Map(docLinkStats.map((r) => [r.requirementId, r.linkCount]));

  // Activity counts (last 30 days) per requirement — includes task activities under each requirement
  const reqIdList = sql.join(reqIds.map((id) => sql`${id}`), sql`, `);
  const reqIdArray = sql`ARRAY[${reqIdList}]::uuid[]`;
  const activityStats = await db
    .select({
      requirementId: sql<string>`coalesce(t.requirement_id, ${activityLog.entityId})`,
      activityCount: sql<number>`count(*)::int`,
      lastActivityAt: sql<string>`max(${activityLog.createdAt})`,
    })
    .from(activityLog)
    .leftJoin(sql`tasks t`, sql`${activityLog.entityType} = 'task' AND ${activityLog.entityId} = t.id`)
    .where(
      and(
        sql`${activityLog.createdAt} >= ${thirtyDaysAgo.toISOString()}`,
        sql`(
          (${activityLog.entityType} = 'requirement' AND ${activityLog.entityId} = ANY(${reqIdArray}))
          OR
          (${activityLog.entityType} = 'task' AND t.requirement_id = ANY(${reqIdArray})
            AND t.id IN (${db.select({ id: tasks.id }).from(tasks).where(authorized.tasks)}))
        )`,
      ),
    )
    .groupBy(sql`coalesce(t.requirement_id, ${activityLog.entityId})`);

  const activityMap = new Map(
    activityStats.map((r) => [r.requirementId, { count: r.activityCount, lastAt: r.lastActivityAt }]),
  );

  // Build heatmap items
  const items: RequirementHeatmapItem[] = reqList.map((req) => {
    const ts = taskStatsMap.get(req.id);
    const totalTasks = ts?.totalTasks ?? 0;
    const completedTasks = ts?.completedTasks ?? 0;
    const overdueTasks = ts?.overdueTasks ?? 0;
    const commentCount = commentMap.get(req.id) ?? 0;
    const documentLinkCount = docLinkMap.get(req.id) ?? 0;
    const activity = activityMap.get(req.id);
    const activityCount = activity?.count ?? 0;
    const lastActivityAt = activity?.lastAt ?? null;

    const daysSinceLastActivity = lastActivityAt
      ? Math.floor((now.getTime() - new Date(lastActivityAt).getTime()) / 86400000)
      : null;

    // Heat score: higher = more active / more attention needed
    // Factors: activity count, overdue tasks, comment engagement
    const activityHeat = Math.min(activityCount / 10, 1) * 40;
    const overdueHeat = totalTasks > 0 ? (overdueTasks / totalTasks) * 30 : 0;
    const engagementHeat = Math.min((commentCount + documentLinkCount) / 10, 1) * 20;
    const recencyHeat = daysSinceLastActivity !== null
      ? Math.max(0, 1 - daysSinceLastActivity / 30) * 10
      : 0;

    const heatScore = Math.round(activityHeat + overdueHeat + engagementHeat + recencyHeat);

    return {
      id: req.id,
      title: req.title,
      status: req.status,
      priority: req.priority,
      totalTasks,
      completedTasks,
      overdueTasks,
      commentCount,
      documentLinkCount,
      activityCount,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
      daysSinceLastActivity,
      heatScore,
    };
  });

  // Sort by heat score descending
  items.sort((a, b) => b.heatScore - a.heatScore);

  // Top 5 hotspots, bottom 5 coldspots (active requirements only)
  const activeItems = items.filter((i) => i.status !== "done");
  const hotspots = activeItems.slice(0, 5);
  const coldspots = activeItems.filter((i) => i.totalTasks > 0).slice(-5).reverse();

  return {
    projectId,
    generatedAt: now.toISOString(),
    requirements: items,
    hotspots,
    coldspots,
  };
}

async function getRequirementOrThrow(db: Database, id: string) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, id),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return requirement;
}
