import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { type Database, projects, requirements, tasks, taskDependencies, requirementDependencies, planDrafts, activityLog, executionSlices, requirementClaims, documents } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  ApplyPlanInput,
  PlanCommentInput,
  PlanDocumentRefInput,
  PlanInput,
  PlanNoteInput,
  PlanRequirementDependencyInput,
  PlanTaskDependencyInput,
} from "@task-weaver/contracts";
import { NotFoundError, ValidationError, ConflictError, BASIC_WORKFLOW, requirementWorkflowSchema, workflowFromPreset, type RequirementWorkflow } from "@task-weaver/contracts";
import type * as DocumentService from "./documents";
import type * as RequirementService from "./requirements";
import type * as TaskService from "./tasks";
import { AuthorizationError } from "@task-weaver/contracts";

interface PlanResourceServices { documentService: typeof DocumentService; requirementService: typeof RequirementService; taskService: typeof TaskService }

type RefMap = Map<string, string>;

export interface PlanApplyRef {
  key: string;
  id: string | null;
  existing: boolean;
  title?: string;
}

export interface PlanApplyResult {
  workflows?: Array<{ key: string; source: string; workflow: RequirementWorkflow | null }>;
  dryRun: boolean;
  summary: {
    requirements: { create: number; reuse: number };
    tasks: { create: number; reuse: number };
    slices: { create: number };
    documents: { create: number; reuse: number };
    requirementDependencies: number;
    taskDependencies: number;
    documentLinks: number;
    documentRequirementLinks: number;
    documentTaskLinks: number;
    taskComments: number;
    taskNotes: number;
  };
  refs: {
    requirements: PlanApplyRef[];
    tasks: PlanApplyRef[];
    slices: PlanApplyRef[];
    documents: PlanApplyRef[];
  };
  warnings: string[];
}

interface NormalizedRequirementDependency {
  requirement: string;
  dependsOn: string;
  type: "blocks" | "related";
  description?: string;
}

interface NormalizedTaskDependency {
  task: string;
  dependsOn: string;
  type: "blocks" | "related";
  description?: string;
}

interface NormalizedDocumentRequirementLink {
  document: string;
  requirement: string;
  type: "references" | "documents" | "output";
}

interface NormalizedDocumentTaskLink {
  document: string;
  task: string;
  type: "references" | "documents" | "output";
}

interface NormalizedDocumentLink {
  source: string;
  target: string;
  type: "reference" | "related" | "parent";
  context?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function applyPlan(
  db: Database,
  input: ApplyPlanInput,
  actor: Actor,
  services?: PlanResourceServices,
): Promise<PlanApplyResult> {
  if (!services) throw new AuthorizationError();
  const { documentService, requirementService, taskService } = services;
  await validateProject(db, input.plan.projectId);
  const normalized = normalizePlan(input.plan);
  await validateExistingEntities(db, input.plan, normalized, services);
  validateReferences(input.plan, normalized);
  await validateSliceAssignments(db, input.plan, normalized, services);
  await validatePlanDependencyCycles(db, input.plan, normalized);

  const initialRefs = buildInitialRefs(input.plan);
  const dryRunResult = buildResult(input.plan, normalized, initialRefs, input.dryRun);
  const project = await db.query.projects.findFirst({ where: eq(projects.id, input.plan.projectId) });
  const workflows = await Promise.all(input.plan.requirements.map(async (requirement) => {
    if (requirement.existingId) {
      const existing = await db.query.requirements.findFirst({ where: eq(requirements.id, requirement.existingId) });
      return { key: requirement.key, source: existing?.workflowSource ?? "legacy", workflow: existing?.workflow ? requirementWorkflowSchema.parse(existing.workflow) : null };
    }
    return { key: requirement.key, source: requirement.workflow || requirement.workflowPreset ? "explicit" : project?.defaultWorkflow ? "project" : "basic", workflow: requirement.workflow ?? (requirement.workflowPreset ? workflowFromPreset(requirement.workflowPreset) : project?.defaultWorkflow ? requirementWorkflowSchema.parse(project.defaultWorkflow) : BASIC_WORKFLOW) };
  }));
  dryRunResult.workflows = workflows;
  if (input.dryRun) return dryRunResult;

  const appliedRefs = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const refs = buildInitialRefs(input.plan);

    for (const document of input.plan.documents) {
      if (document.existingId) continue;
      const created = await documentService.createDocument(txDb, {
        projectId: document.projectId === undefined ? input.plan.projectId : document.projectId ?? undefined,
        title: document.title!,
        content: document.content ?? "",
        tags: document.tags,
        summary: document.summary,
        keywords: document.keywords,
        docType: document.docType,
        language: document.language,
        generatedBy: document.generatedBy,
        generationPrompt: document.generationPrompt,
        confidence: document.confidence,
        needsReview: document.needsReview,
      }, actor);
      refs.documents.set(document.key, created.id);
    }

    for (const requirement of input.plan.requirements) {
      if (requirement.existingId) continue;
      const created = await requirementService.createRequirement(txDb, {
        projectId: input.plan.projectId,
        title: requirement.title!,
        description: requirement.description,
        status: requirement.status,
        priority: requirement.priority,
        modelTier: requirement.modelTier,
        tags: requirement.tags,
        branchName: requirement.branchName,
        expectedAt: requirement.expectedAt,
        workflow: requirement.workflow,
        workflowPreset: requirement.workflowPreset,
        recoveryPolicy: requirement.recoveryPolicy,
      }, actor);
      refs.requirements.set(requirement.key, created.id);
    }

    for (const { requirement, task } of listPlanTasks(input.plan)) {
      if (task.existingId) continue;
      const requirementId = resolveRef(requirement.key, refs.requirements, "requirement");
      const created = await taskService.createTask(txDb, {
        scope: "project",
        projectId: input.plan.projectId,
        requirementId,
        title: task.title!,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee,
        assigneeType: task.assigneeType,
        requestedProvider: task.requestedProvider,
        requestedModel: task.requestedModel,
        tags: task.tags,
        branchName: task.branchName,
        expectedAt: task.expectedAt,
      }, actor);
      refs.tasks.set(task.key, created.id);
    }

    for (const requirement of input.plan.requirements) {
      const requirementId = resolveRef(requirement.key, refs.requirements, "requirement");
      for (const slice of requirement.slices) {
        const assignedTaskRefs = normalized.sliceTasks.get(slice.key) ?? [];
        const taskIds = assignedTaskRefs.map((ref) => resolveRef(ref, refs.tasks, "task"));
        const created = await requirementService.createExecutionSlice(txDb, requirementId, {
          title: slice.title,
          description: slice.description,
          orderIndex: slice.orderIndex,
          allowParallel: slice.allowParallel,
          modelTier: slice.modelTier,
          taskIds,
        }, actor);
        refs.slices.set(slice.key, created.id);
      }
    }

    for (const dependency of normalized.requirementDependencies) {
      await requirementService.addRequirementDependency(
        txDb,
        resolveRef(dependency.requirement, refs.requirements, "requirement"),
        resolveRef(dependency.dependsOn, refs.requirements, "requirement"),
        dependency.type,
        actor,
        dependency.description,
      );
    }

    for (const dependency of normalized.taskDependencies) {
      await taskService.addTaskDependency(
        txDb,
        resolveRef(dependency.task, refs.tasks, "task"),
        resolveRef(dependency.dependsOn, refs.tasks, "task"),
        dependency.type,
        actor,
        dependency.description,
      );
    }

    for (const link of normalized.documentLinks) {
      await documentService.linkDocuments(
        txDb,
        resolveRef(link.source, refs.documents, "document"),
        resolveRef(link.target, refs.documents, "document"),
        link.type,
        actor,
        link.context,
      );
    }

    for (const link of normalized.documentRequirementLinks) {
      await requirementService.linkDocumentToRequirement(
        txDb,
        resolveRef(link.requirement, refs.requirements, "requirement"),
        resolveRef(link.document, refs.documents, "document"),
        link.type,
        actor,
      );
    }

    for (const link of normalized.documentTaskLinks) {
      await documentService.linkDocumentToTask(
        txDb,
        resolveRef(link.document, refs.documents, "document"),
        resolveRef(link.task, refs.tasks, "task"),
        link.type,
        actor,
      );
    }

    for (const { task } of listPlanTasks(input.plan)) {
      const taskId = resolveRef(task.key, refs.tasks, "task");
      for (const comment of task.comments) {
        await taskService.addTaskComment(txDb, taskId, normalizeComment(comment), actor);
      }
      for (const note of task.notes) {
        const normalizedNote = normalizeNote(note);
        await taskService.addTaskNote(txDb, taskId, normalizedNote.content, normalizedNote.pinned, actor);
      }
    }

    return refs;
  });

  return { ...buildResult(input.plan, normalized, appliedRefs, false), workflows };
}

async function validateProject(db: Database, projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) throw new NotFoundError("Project not found");
  if (project.status === "archived") {
    throw new ValidationError("Cannot apply a plan to an archived project");
  }
}

async function validateExistingEntities(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  services: PlanResourceServices,
) {
  const { documentService, requirementService, taskService } = services;
  const requirementKeys = new Set<string>();
  const taskKeys = new Set<string>();
  const documentKeys = new Set<string>();
  const sliceKeys = new Set<string>();

  assertUniqueKeys("document", plan.documents.map((doc) => doc.key), documentKeys);
  assertUniqueKeys("requirement", plan.requirements.map((req) => req.key), requirementKeys);

  for (const requirement of plan.requirements) {
    assertUniqueKeys("slice", requirement.slices.map((slice) => slice.key), sliceKeys);
    assertUniqueKeys("task", requirement.tasks.map((task) => task.key), taskKeys);
  }

  for (const document of plan.documents) {
    if (!document.existingId) continue;
    const existing = await documentService.getDocument(db, document.existingId);
    if (existing.projectId && existing.projectId !== plan.projectId) {
      throw new ValidationError(`Document ${document.key} belongs to a different project`);
    }
  }

  for (const requirement of plan.requirements) {
    if (!requirement.existingId) continue;
    const existing = await requirementService.getRequirementRecord(db, requirement.existingId);
    if (existing.projectId !== plan.projectId) {
      throw new ValidationError(`Requirement ${requirement.key} belongs to a different project`);
    }
  }

  for (const { requirement, task } of listPlanTasks(plan)) {
    if (!task.existingId) continue;
    if (!requirement.existingId) {
      throw new ValidationError(`Existing task ${task.key} cannot be nested under new requirement ${requirement.key}`);
    }
    const existing = await taskService.getTask(db, task.existingId);
    if (existing.projectId !== plan.projectId) {
      throw new ValidationError(`Task ${task.key} belongs to a different project`);
    }
    const requirementId = requirement.existingId;
    if (requirementId && existing.requirementId !== requirementId) {
      throw new ValidationError(`Task ${task.key} does not belong to requirement ${requirement.key}`);
    }
  }

  await validateDirectRequirementRefs(db, plan, normalized, services);
  await validateDirectTaskRefs(db, plan, normalized, services);
  await validateDirectDocumentRefs(db, plan, normalized, services);
}

async function validateDirectRequirementRefs(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  services: PlanResourceServices,
) {
  const { requirementService } = services;
  const known = new Set(plan.requirements.map((req) => req.key));
  const refs = collectDirectRefs([
    ...normalized.requirementDependencies.flatMap((dep) => [dep.requirement, dep.dependsOn]),
    ...normalized.documentRequirementLinks.map((link) => link.requirement),
  ], known);

  for (const ref of refs) {
    const requirement = await requirementService.getRequirementRecord(db, ref);
    if (requirement.projectId !== plan.projectId) {
      throw new ValidationError(`Requirement reference ${ref} belongs to a different project`);
    }
  }
}

async function validateDirectTaskRefs(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  services: PlanResourceServices,
) {
  const { taskService } = services;
  const known = new Set(listPlanTasks(plan).map(({ task }) => task.key));
  const refs = collectDirectRefs([
    ...normalized.taskDependencies.flatMap((dep) => [dep.task, dep.dependsOn]),
    ...normalized.documentTaskLinks.map((link) => link.task),
    ...[...normalized.sliceTasks.values()].flat(),
  ], known);

  for (const ref of refs) {
    const task = await taskService.getTask(db, ref);
    if (task.projectId !== plan.projectId) {
      throw new ValidationError(`Task reference ${ref} belongs to a different project`);
    }
  }
}

async function validateDirectDocumentRefs(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  services: PlanResourceServices,
) {
  const { documentService } = services;
  const known = new Set(plan.documents.map((doc) => doc.key));
  const refs = collectDirectRefs([
    ...normalized.documentLinks.flatMap((link) => [link.source, link.target]),
    ...normalized.documentRequirementLinks.map((link) => link.document),
    ...normalized.documentTaskLinks.map((link) => link.document),
  ], known);

  for (const ref of refs) {
    const document = await documentService.getDocument(db, ref);
    if (document.projectId && document.projectId !== plan.projectId) {
      throw new ValidationError(`Document reference ${ref} belongs to a different project`);
    }
  }
}

function collectDirectRefs(refs: string[], knownKeys: Set<string>) {
  return [...new Set(refs.filter((ref) => !knownKeys.has(ref) && UUID_RE.test(ref)))];
}

function assertUniqueKeys(kind: string, keys: string[], seen: Set<string>) {
  for (const key of keys) {
    if (seen.has(key)) throw new ValidationError(`Duplicate ${kind} key: ${key}`);
    seen.add(key);
  }
}

function normalizePlan(plan: PlanInput) {
  const requirementDependencies: NormalizedRequirementDependency[] = [...plan.requirementDependencies];
  const taskDependencies: NormalizedTaskDependency[] = [...plan.taskDependencies];
  const documentLinks: NormalizedDocumentLink[] = [...plan.documentLinks];
  const documentRequirementLinks: NormalizedDocumentRequirementLink[] = [...plan.documentRequirementLinks];
  const documentTaskLinks: NormalizedDocumentTaskLink[] = [...plan.documentTaskLinks];
  const sliceTasks = new Map<string, string[]>();

  for (const document of plan.documents) {
    for (const link of document.links) {
      documentLinks.push({
        source: document.key,
        target: link.document,
        type: link.type,
        context: link.context,
      });
    }
  }

  for (const requirement of plan.requirements) {
    for (const dependency of [...requirement.dependsOn, ...requirement.dependencies]) {
      const normalized = normalizeRequirementDependency(dependency);
      requirementDependencies.push({
        requirement: requirement.key,
        dependsOn: normalized.requirement,
        type: normalized.type,
        description: normalized.description,
      });
    }

    for (const document of requirement.documents) {
      const normalized = normalizeDocumentRef(document);
      documentRequirementLinks.push({
        document: normalized.document,
        requirement: requirement.key,
        type: normalized.type,
      });
    }

    for (const slice of requirement.slices) {
      sliceTasks.set(slice.key, [...slice.tasks]);
    }

    for (const task of requirement.tasks) {
      if (task.slice) {
        const assigned = sliceTasks.get(task.slice) ?? [];
        assigned.push(task.key);
        sliceTasks.set(task.slice, assigned);
      }

      for (const dependency of [...task.dependsOn, ...task.dependencies]) {
        const normalized = normalizeTaskDependency(dependency);
        taskDependencies.push({
          task: task.key,
          dependsOn: normalized.task,
          type: normalized.type,
          description: normalized.description,
        });
      }

      for (const document of task.documents) {
        const normalized = normalizeDocumentRef(document);
        documentTaskLinks.push({
          document: normalized.document,
          task: task.key,
          type: normalized.type,
        });
      }
    }
  }

  for (const [sliceKey, taskRefs] of sliceTasks) {
    sliceTasks.set(sliceKey, [...new Set(taskRefs)]);
  }

  return {
    requirementDependencies,
    taskDependencies,
    documentLinks,
    documentRequirementLinks,
    documentTaskLinks,
    sliceTasks,
  };
}

function normalizeDocumentRef(input: PlanDocumentRefInput) {
  return typeof input === "string"
    ? { document: input, type: "references" as const }
    : input;
}

function normalizeTaskDependency(input: PlanTaskDependencyInput) {
  return typeof input === "string"
    ? { task: input, type: "blocks" as const }
    : input;
}

function normalizeRequirementDependency(input: PlanRequirementDependencyInput) {
  return typeof input === "string"
    ? { requirement: input, type: "blocks" as const }
    : input;
}

function normalizeComment(input: PlanCommentInput) {
  return typeof input === "string" ? input : input.content;
}

function normalizeNote(input: PlanNoteInput) {
  return typeof input === "string"
    ? { content: input, pinned: false }
    : { content: input.content, pinned: input.pinned };
}

function validateReferences(
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
) {
  const requirementRefs = new Set(plan.requirements.map((req) => req.key));
  const taskRefs = new Set(listPlanTasks(plan).map(({ task }) => task.key));
  const documentRefs = new Set(plan.documents.map((doc) => doc.key));
  const sliceRefs = new Set(plan.requirements.flatMap((req) => req.slices.map((slice) => slice.key)));

  for (const dep of normalized.requirementDependencies) {
    assertKnownRef(dep.requirement, requirementRefs, "requirement");
    assertKnownRef(dep.dependsOn, requirementRefs, "requirement");
  }
  for (const dep of normalized.taskDependencies) {
    assertKnownRef(dep.task, taskRefs, "task");
    assertKnownRef(dep.dependsOn, taskRefs, "task");
  }
  for (const link of normalized.documentLinks) {
    assertKnownRef(link.source, documentRefs, "document");
    assertKnownRef(link.target, documentRefs, "document");
  }
  for (const link of normalized.documentRequirementLinks) {
    assertKnownRef(link.document, documentRefs, "document");
    assertKnownRef(link.requirement, requirementRefs, "requirement");
  }
  for (const link of normalized.documentTaskLinks) {
    assertKnownRef(link.document, documentRefs, "document");
    assertKnownRef(link.task, taskRefs, "task");
  }
  for (const [slice, tasksInSlice] of normalized.sliceTasks) {
    assertKnownRef(slice, sliceRefs, "slice");
    for (const task of tasksInSlice) {
      assertKnownRef(task, taskRefs, "task");
    }
  }
}

async function validateSliceAssignments(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  services: PlanResourceServices,
) {
  const { taskService } = services;
  const taskRequirement = new Map<string, string>();
  const sliceRequirement = new Map<string, PlanRequirementInputLike>();

  for (const requirement of plan.requirements) {
    for (const task of requirement.tasks) {
      taskRequirement.set(task.key, requirement.key);
    }
    for (const slice of requirement.slices) {
      sliceRequirement.set(slice.key, requirement);
    }
  }

  for (const [sliceKey, taskRefs] of normalized.sliceTasks) {
    const requirement = sliceRequirement.get(sliceKey);
    if (!requirement) continue;

    for (const taskRef of taskRefs) {
      const ownerRequirementKey = taskRequirement.get(taskRef);
      if (ownerRequirementKey && ownerRequirementKey !== requirement.key) {
        throw new ValidationError(`Slice ${sliceKey} cannot include task ${taskRef} from requirement ${ownerRequirementKey}`);
      }
      if (UUID_RE.test(taskRef)) {
        if (!requirement.existingId) {
          throw new ValidationError(`Slice ${sliceKey} cannot include existing task ${taskRef} under new requirement ${requirement.key}`);
        }
        const task = await taskService.getTask(db, taskRef);
        if (task.requirementId !== requirement.existingId) {
          throw new ValidationError(`Slice ${sliceKey} task ${taskRef} does not belong to requirement ${requirement.key}`);
        }
      }
    }
  }
}

interface PlanRequirementInputLike {
  key: string;
  existingId?: string;
}

function assertKnownRef(ref: string, knownKeys: Set<string>, kind: string) {
  if (knownKeys.has(ref) || UUID_RE.test(ref)) return;
  throw new ValidationError(`Unknown ${kind} reference: ${ref}`);
}

async function validatePlanDependencyCycles(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  rejectDuplicates = false,
) {
  const requirementRefs = new Map(plan.requirements.map((item) => [item.key, item.existingId ?? `new:${item.key}`]));
  const taskRefs = new Map(listPlanTasks(plan).map(({ task }) => [task.key, task.existingId ?? `new:${task.key}`]));
  const [liveRequirements, liveTasks] = await Promise.all([
    db.select({ from: requirementDependencies.requirementId, to: requirementDependencies.dependsOnRequirementId, type: requirementDependencies.type })
      .from(requirementDependencies).innerJoin(requirements, eq(requirementDependencies.requirementId, requirements.id))
      .where(eq(requirements.projectId, plan.projectId)),
    db.select({ from: taskDependencies.taskId, to: taskDependencies.dependsOnTaskId, type: taskDependencies.type })
      .from(taskDependencies).innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
      .where(eq(tasks.projectId, plan.projectId)),
  ]);
  const proposedRequirements = normalized.requirementDependencies.map(edge => ({
    from: requirementRefs.get(edge.requirement) ?? edge.requirement,
    to: requirementRefs.get(edge.dependsOn) ?? edge.dependsOn,
    type: edge.type,
  }));
  const proposedTasks = normalized.taskDependencies.map(edge => ({
    from: taskRefs.get(edge.task) ?? edge.task,
    to: taskRefs.get(edge.dependsOn) ?? edge.dependsOn,
    type: edge.type,
  }));
  if (rejectDuplicates) {
    assertNoDuplicatePlanEdges(liveRequirements, proposedRequirements, "requirement");
    assertNoDuplicatePlanEdges(liveTasks, proposedTasks, "task");
  }
  assertPlanGraphAcyclic(liveRequirements, proposedRequirements, "requirement");
  assertPlanGraphAcyclic(liveTasks, proposedTasks, "task");
}

function assertNoDuplicatePlanEdges(live: Array<{ from: string; to: string; type: string }>, proposed: Array<{ from: string; to: string; type: string }>, kind: string) {
  const seen = new Set(live.map(edge => JSON.stringify([edge.from, edge.to, edge.type])));
  for (const edge of proposed) {
    const key = JSON.stringify([edge.from, edge.to, edge.type]);
    if (seen.has(key)) throw new ValidationError(`Duplicate ${kind} dependency`);
    seen.add(key);
  }
}

/** Validate proposed edges against the live graph, including aliases for existing entities. */
export function assertPlanGraphAcyclic(
  live: Array<{ from: string; to: string }>,
  proposed: Array<{ from: string; to: string }>,
  kind: "requirement" | "task",
) {
  const graph = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const edge of [...live, ...proposed]) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    graph.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
    if (!graph.has(edge.to)) graph.set(edge.to, []);
    if (!reverse.has(edge.from)) reverse.set(edge.from, []);
  }
  // Iterative Kosaraju traversal keeps work linear in the project graph size
  // and avoids stack exhaustion. Only components containing a proposed edge
  // are rejected, so an unrelated legacy cycle does not block planning.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const root of graph.keys()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const neighbors = graph.get(frame.node)!;
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next++]!;
        if (!seen.has(next)) { seen.add(next); stack.push({ node: next, next: 0 }); }
      } else {
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  const component = new Map<string, number>();
  let componentId = 0;
  for (const root of order.reverse()) {
    if (component.has(root)) continue;
    const pending = [root];
    component.set(root, componentId);
    while (pending.length) {
      for (const next of reverse.get(pending.pop()!) ?? []) {
        if (!component.has(next)) { component.set(next, componentId); pending.push(next); }
      }
    }
    componentId++;
  }
  for (const edge of proposed) {
    if (component.get(edge.from) === component.get(edge.to)) {
      throw new ValidationError(`Plan ${kind} dependencies contain a cycle at ${edge.from}`);
    }
  }
}

function listPlanTasks(plan: PlanInput) {
  return plan.requirements.flatMap((requirement) =>
    requirement.tasks.map((task) => ({ requirement, task })),
  );
}

function buildInitialRefs(plan: PlanInput) {
  return {
    requirements: new Map(existingRefEntries(plan.requirements)),
    tasks: new Map(existingRefEntries(listPlanTasks(plan).map(({ task }) => task))),
    documents: new Map(existingRefEntries(plan.documents)),
    slices: new Map<string, string>(),
  };
}

function existingRefEntries(items: Array<{ key: string; existingId?: string }>) {
  const entries: Array<[string, string]> = [];
  for (const item of items) {
    if (item.existingId) entries.push([item.key, item.existingId]);
  }
  return entries;
}

function resolveRef(ref: string, refs: RefMap, kind: string) {
  const mapped = refs.get(ref);
  if (mapped) return mapped;
  if (UUID_RE.test(ref)) return ref;
  throw new ValidationError(`Unable to resolve ${kind} reference: ${ref}`);
}

function buildResult(
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
  refs: { requirements: RefMap; tasks: RefMap; documents: RefMap; slices: RefMap },
  dryRun: boolean,
): PlanApplyResult {
  const taskItems = listPlanTasks(plan).map(({ task }) => task);
  return {
    dryRun,
    summary: {
      requirements: countCreateReuse(plan.requirements),
      tasks: countCreateReuse(taskItems),
      slices: { create: plan.requirements.reduce((sum, req) => sum + req.slices.length, 0) },
      documents: countCreateReuse(plan.documents),
      requirementDependencies: normalized.requirementDependencies.length,
      taskDependencies: normalized.taskDependencies.length,
      documentLinks: normalized.documentLinks.length,
      documentRequirementLinks: normalized.documentRequirementLinks.length,
      documentTaskLinks: normalized.documentTaskLinks.length,
      taskComments: taskItems.reduce((sum, task) => sum + task.comments.length, 0),
      taskNotes: taskItems.reduce((sum, task) => sum + task.notes.length, 0),
    },
    refs: {
      requirements: plan.requirements.map((req) => buildRef(req, refs.requirements, req.title)),
      tasks: taskItems.map((task) => buildRef(task, refs.tasks, task.title)),
      slices: plan.requirements.flatMap((req) =>
        req.slices.map((slice) => buildRef({ key: slice.key, existingId: undefined }, refs.slices, slice.title)),
      ),
      documents: plan.documents.map((doc) => buildRef(doc, refs.documents, doc.title)),
    },
    warnings: buildWarnings(plan),
  };
}

function countCreateReuse(items: Array<{ existingId?: string }>) {
  return {
    create: items.filter((item) => !item.existingId).length,
    reuse: items.filter((item) => item.existingId).length,
  };
}

function buildRef(
  item: { key: string; existingId?: string },
  refs: RefMap,
  title?: string,
): PlanApplyRef {
  return {
    key: item.key,
    id: refs.get(item.key) ?? null,
    existing: Boolean(item.existingId),
    title,
  };
}

function buildWarnings(plan: PlanInput) {
  const warnings: string[] = [];
  const hasDraftExecutableTasks = plan.requirements.some((req) =>
    !req.existingId &&
    req.status === "draft" &&
    req.tasks.some((task) => !task.existingId && task.status === "todo"),
  );
  if (hasDraftExecutableTasks) {
    warnings.push("New requirements remain draft and need approval before daemon execution.");
  }
  for (const [kind, items] of [["requirement", plan.requirements], ["task", listPlanTasks(plan).map(({ task }) => task)], ["document", plan.documents]] as const) {
    const titles = new Set<string>();
    for (const item of items) {
      const title = item.title?.trim().toLocaleLowerCase("en-US");
      if (title && titles.has(title)) warnings.push(`Multiple ${kind} entries have the same title: ${item.title}`);
      if (title) titles.add(title);
    }
  }
  return warnings;
}

const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Draft operations are authorized by the resource-service boundary. */
export async function createPlanDraft(db: Database, input: import("@task-weaver/contracts").CreatePlanDraftInput, actor: Actor) {
  const { stagedPlanSchema } = await import("@task-weaver/contracts");
  const plan = stagedPlanSchema.parse(input.plan);
  // Opportunistically prune a bounded batch; applied receipts remain durable.
  const expired = await db.select({ id: planDrafts.id }).from(planDrafts).where(and(eq(planDrafts.projectId, plan.projectId), inArray(planDrafts.state, ["draft", "discarded"]), lte(planDrafts.expiresAt, new Date()))).limit(100);
  if (expired.length) {
    await db.delete(planDrafts).where(and(eq(planDrafts.projectId, plan.projectId), inArray(planDrafts.id, expired.map(item => item.id)), inArray(planDrafts.state, ["draft", "discarded"]), lte(planDrafts.expiresAt, new Date())));
    for (const item of expired) await recordDraftActivity(db, plan.projectId, item.id, "expired", actor);
  }
  const [draft] = await db.insert(planDrafts).values({
    projectId: plan.projectId, createdBy: actor.id, createdByType: actor.type, source: input.source,
    plan: JSON.parse(JSON.stringify(plan)), expiresAt: new Date(Date.now() + DRAFT_RETENTION_MS),
  }).returning();
  await recordDraftActivity(db, draft!.projectId, draft!.id, "created", actor);
  return draft!;
}

export async function getPlanDraft(db: Database, projectId: string, draftId: string) {
  const [draft] = await db.select().from(planDrafts).where(and(eq(planDrafts.projectId, projectId), eq(planDrafts.id, draftId)));
  if (!draft || draft.state !== "draft" || draft.expiresAt <= new Date()) throw new NotFoundError("Plan draft not found");
  return { ...draft, canWrite: false };
}

export async function planDraftCapabilities(_db: Database, _projectId: string) { return { canWrite: false }; }

export async function listPlanDrafts(db: Database, projectId: string) {
  return db.select({ id: planDrafts.id, projectId: planDrafts.projectId, createdBy: planDrafts.createdBy, createdByType: planDrafts.createdByType, source: planDrafts.source, revision: planDrafts.revision, createdAt: planDrafts.createdAt, updatedAt: planDrafts.updatedAt, expiresAt: planDrafts.expiresAt }).from(planDrafts).where(and(eq(planDrafts.projectId, projectId), eq(planDrafts.state, "draft"), gt(planDrafts.expiresAt, new Date()))).orderBy(desc(planDrafts.updatedAt)).limit(100);
}

export async function updatePlanDraft(db: Database, draftId: string, input: import("@task-weaver/contracts").UpdatePlanDraftInput, actor: Actor) {
  const { stagedPlanSchema } = await import("@task-weaver/contracts");
  const plan = stagedPlanSchema.parse(input.plan);
  if (plan.projectId !== input.projectId) throw new ValidationError("Draft project cannot be changed");
  const [draft] = await db.update(planDrafts).set({ plan: JSON.parse(JSON.stringify(plan)), revision: input.revision + 1, validatedRevision: null, liveFingerprint: null, updatedAt: new Date() })
    .where(and(eq(planDrafts.id, draftId), eq(planDrafts.projectId, input.projectId), eq(planDrafts.revision, input.revision), eq(planDrafts.state, "draft"), gt(planDrafts.expiresAt, new Date()))).returning();
  if (!draft) {
    const current = await getPlanDraft(db, input.projectId, draftId);
    throw new ConflictError("Plan draft has changed", current.revision);
  }
  await recordDraftActivity(db, draft.projectId, draft.id, "updated", actor);
  return draft;
}

export async function discardPlanDraft(db: Database, projectId: string, draftId: string, revision: number, actor: Actor) {
  const [draft] = await db.update(planDrafts).set({ state: "discarded", revision: revision + 1, updatedAt: new Date() })
    .where(and(eq(planDrafts.id, draftId), eq(planDrafts.projectId, projectId), eq(planDrafts.revision, revision), eq(planDrafts.state, "draft"), gt(planDrafts.expiresAt, new Date()))).returning();
  if (!draft) {
    const current = await getPlanDraft(db, projectId, draftId);
    throw new ConflictError("Plan draft has changed", current.revision);
  }
  await recordDraftActivity(db, projectId, draftId, "discarded", actor);
  return { id: draftId, revision: draft.revision };
}

async function recordDraftActivity(db: Database, projectId: string, draftId: string, action: string, actor: Actor) {
  await db.insert(activityLog).values({ entityType: "project", entityId: projectId, action: `plan_draft.${action}`, actorId: actor.id, actorType: actor.type, metadata: { draftId } });
}

export async function validatePlanDraft(db: Database, projectId: string, draftId: string, actor: Actor, services?: PlanResourceServices) {
  const { stagedPlanSchema } = await import("@task-weaver/contracts");
  const draft = await getPlanDraft(db, projectId, draftId);
  const plan = stagedPlanSchema.parse(draft.plan);
  const result = await applyPlan(db, { plan, dryRun: true }, actor, services);
  const normalized = normalizePlan(plan);
  await validatePlanDependencyCycles(db, plan, normalized, true);
  const existingTasks = new Map(listPlanTasks(plan).map(({ task }) => [task.key, task.existingId ?? `new:${task.key}`]));
  const assignments = new Map<string, string>();
  for (const [slice, refs] of normalized.sliceTasks) {
    for (const ref of refs) {
      const identity = existingTasks.get(ref) ?? ref;
      const previous = assignments.get(identity);
      if (previous && previous !== slice) throw new ValidationError(`Task ${ref} is assigned to multiple slices`);
      assignments.set(identity, slice);
    }
  }
  const requirementIds = new Set(plan.requirements.flatMap(item => item.existingId ? [item.existingId] : []));
  const taskIds = new Set(listPlanTasks(plan).flatMap(({ task }) => task.existingId ? [task.existingId] : []));
  const reqKeys = new Set(plan.requirements.map(item => item.key));
  const taskKeys = new Set(listPlanTasks(plan).map(({ task }) => task.key));
  for (const id of collectDirectRefs([...normalized.requirementDependencies.flatMap(edge => [edge.requirement, edge.dependsOn]), ...normalized.documentRequirementLinks.map(link => link.requirement)], reqKeys)) requirementIds.add(id);
  for (const id of collectDirectRefs([...normalized.taskDependencies.flatMap(edge => [edge.task, edge.dependsOn]), ...normalized.documentTaskLinks.map(link => link.task), ...[...normalized.sliceTasks.values()].flat()], taskKeys)) taskIds.add(id);
  const [terminalRequirements, cancelledTasks] = await Promise.all([
    requirementIds.size ? db.select({ id: requirements.id }).from(requirements).where(and(inArray(requirements.id, [...requirementIds]), inArray(requirements.status, ["cancelled", "archived"]))) : [],
    taskIds.size ? db.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, [...taskIds]), eq(tasks.status, "cancelled"))) : [],
  ]);
  if (terminalRequirements.length || cancelledTasks.length) throw new ValidationError("A referenced requirement or task is cancelled or archived");
  const fingerprint = await livePlanFingerprint(db, projectId);
  await db.update(planDrafts).set({ validatedRevision: draft.revision, liveFingerprint: fingerprint }).where(and(eq(planDrafts.id, draftId), eq(planDrafts.revision, draft.revision)));
  return { revision: draft.revision, result };
}

async function livePlanFingerprint(db: Database, projectId: string): Promise<string> {
  const [project, reqs, projectTasks, reqEdges, taskEdges, slices, claims, projectDocuments] = await Promise.all([
    db.select({ defaultWorkflow: projects.defaultWorkflow, status: projects.status }).from(projects).where(eq(projects.id, projectId)),
    db.select({ id: requirements.id, revision: requirements.planRevision, status: requirements.status, leaseGeneration: requirements.leaseGeneration, workflowStateRevision: requirements.workflowStateRevision }).from(requirements).where(eq(requirements.projectId, projectId)).orderBy(requirements.id),
    db.select({ id: tasks.id, version: tasks.version, status: tasks.status, requirementId: tasks.requirementId }).from(tasks).where(eq(tasks.projectId, projectId)).orderBy(tasks.id),
    db.select({ id: requirementDependencies.id, from: requirementDependencies.requirementId, to: requirementDependencies.dependsOnRequirementId, type: requirementDependencies.type }).from(requirementDependencies).innerJoin(requirements, eq(requirementDependencies.requirementId, requirements.id)).where(eq(requirements.projectId, projectId)).orderBy(requirementDependencies.id),
    db.select({ id: taskDependencies.id, from: taskDependencies.taskId, to: taskDependencies.dependsOnTaskId, type: taskDependencies.type }).from(taskDependencies).innerJoin(tasks, eq(taskDependencies.taskId, tasks.id)).where(eq(tasks.projectId, projectId)).orderBy(taskDependencies.id),
    db.select({ id: executionSlices.id, requirementId: executionSlices.requirementId, order: executionSlices.orderIndex, status: executionSlices.status }).from(executionSlices).innerJoin(requirements, eq(executionSlices.requirementId, requirements.id)).where(eq(requirements.projectId, projectId)).orderBy(executionSlices.id),
    db.select({ id: requirementClaims.id, requirementId: requirementClaims.requirementId, claimedBy: requirementClaims.claimedBy, expiresAt: requirementClaims.expiresAt }).from(requirementClaims).innerJoin(requirements, eq(requirementClaims.requirementId, requirements.id)).where(eq(requirements.projectId, projectId)).orderBy(requirementClaims.id),
    db.select({ id: documents.id, version: documents.version }).from(documents).where(eq(documents.projectId, projectId)).orderBy(documents.id),
  ]);
  return createHash("sha256").update(JSON.stringify([project, reqs, projectTasks, reqEdges, taskEdges, slices, claims, projectDocuments])).digest("hex");
}

export async function applyPlanDraft(db: Database, projectId: string, draftId: string, revision: number, operationKey: string, actor: Actor, services?: PlanResourceServices) {
  if (!services) throw new AuthorizationError();
  const [draft] = await db.select().from(planDrafts).where(and(eq(planDrafts.projectId, projectId), eq(planDrafts.id, draftId))).for("update");
  if (!draft) throw new NotFoundError("Plan draft not found");
  if (draft.state === "applied") {
    if (draft.operationKey !== operationKey || draft.revision !== revision || !draft.receipt) throw new ConflictError("Draft was already applied", draft.revision);
    const receipt = draft.receipt as unknown as PlanApplyResult;
    for (const item of receipt.refs.requirements) if (item.id) await services.requirementService.getRequirementRecord(db, item.id);
    for (const item of receipt.refs.tasks) if (item.id) await services.taskService.getTask(db, item.id);
    for (const item of receipt.refs.documents) if (item.id) await services.documentService.getDocument(db, item.id);
    return { result: receipt, replayed: true };
  }
  if (draft.state !== "draft" || draft.expiresAt <= new Date()) throw new NotFoundError("Plan draft not found");
  const [keyOwner] = await db.select({ id: planDrafts.id }).from(planDrafts).where(and(eq(planDrafts.projectId, projectId), eq(planDrafts.operationKey, operationKey)));
  if (keyOwner && keyOwner.id !== draftId) throw new ConflictError("Operation key already identifies another draft", draft.revision);
  if (draft.revision !== revision || draft.validatedRevision !== revision || !draft.liveFingerprint) throw new ConflictError("Draft must be validated at its current revision", draft.revision);
  if (draft.liveFingerprint !== await livePlanFingerprint(db, projectId)) throw new ConflictError("Project plan has changed; validate again", draft.revision);
  const { stagedPlanSchema } = await import("@task-weaver/contracts");
  const plan = stagedPlanSchema.parse(draft.plan);
  // Revalidate under the same transaction and resource authorization lock.
  await validatePlanDraft(db, projectId, draftId, actor, services);
  const result = await applyPlan(db, { plan, dryRun: false }, actor, services);
  await db.update(planDrafts).set({ state: "applied", operationKey, receipt: JSON.parse(JSON.stringify(result)), updatedAt: new Date() }).where(eq(planDrafts.id, draftId));
  await recordDraftActivity(db, projectId, draftId, "applied", actor);
  return { result, replayed: false };
}

export async function getPlanDraftReceipt(db: Database, projectId: string, draftId: string, services?: PlanResourceServices) {
  if (!services) throw new AuthorizationError();
  const [draft] = await db.select().from(planDrafts).where(and(eq(planDrafts.projectId, projectId), eq(planDrafts.id, draftId), eq(planDrafts.state, "applied")));
  if (!draft?.receipt) throw new NotFoundError("Plan receipt not found");
  const receipt = draft.receipt as unknown as PlanApplyResult;
  for (const ref of receipt.refs.requirements) if (ref.id) await services.requirementService.getRequirementRecord(db, ref.id);
  for (const ref of receipt.refs.tasks) if (ref.id) await services.taskService.getTask(db, ref.id);
  for (const ref of receipt.refs.documents) if (ref.id) await services.documentService.getDocument(db, ref.id);
  return { result: receipt, revision: draft.revision };
}
