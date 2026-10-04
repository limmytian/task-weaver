import { eq } from "drizzle-orm";
import { type Database, projects } from "@task-weaver/db";
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
import { NotFoundError, ValidationError } from "@task-weaver/contracts";
import * as documentService from "./documents";
import * as requirementService from "./requirements";
import * as taskService from "./tasks";

type RefMap = Map<string, string>;

export interface PlanApplyRef {
  key: string;
  id: string | null;
  existing: boolean;
  title?: string;
}

export interface PlanApplyResult {
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
): Promise<PlanApplyResult> {
  await validateProject(db, input.plan.projectId);
  const normalized = normalizePlan(input.plan);
  await validateExistingEntities(db, input.plan, normalized);
  validateReferences(input.plan, normalized);
  await validateSliceAssignments(db, input.plan, normalized);
  validateDependencyCycles(normalized.requirementDependencies, "requirement");
  validateDependencyCycles(normalized.taskDependencies, "task");

  const initialRefs = buildInitialRefs(input.plan);
  const dryRunResult = buildResult(input.plan, normalized, initialRefs, input.dryRun);
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

  return buildResult(input.plan, normalized, appliedRefs, false);
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
) {
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
    const existing = await requirementService.getRequirement(db, requirement.existingId);
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

  await validateDirectRequirementRefs(db, plan, normalized);
  await validateDirectTaskRefs(db, plan, normalized);
  await validateDirectDocumentRefs(db, plan, normalized);
}

async function validateDirectRequirementRefs(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
) {
  const known = new Set(plan.requirements.map((req) => req.key));
  const refs = collectDirectRefs([
    ...normalized.requirementDependencies.flatMap((dep) => [dep.requirement, dep.dependsOn]),
    ...normalized.documentRequirementLinks.map((link) => link.requirement),
  ], known);

  for (const ref of refs) {
    const requirement = await requirementService.getRequirement(db, ref);
    if (requirement.projectId !== plan.projectId) {
      throw new ValidationError(`Requirement reference ${ref} belongs to a different project`);
    }
  }
}

async function validateDirectTaskRefs(
  db: Database,
  plan: PlanInput,
  normalized: ReturnType<typeof normalizePlan>,
) {
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
) {
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
) {
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

function validateDependencyCycles(
  dependencies: Array<{ requirement?: string; task?: string; dependsOn: string }>,
  kind: "requirement" | "task",
) {
  const graph = new Map<string, string[]>();
  for (const dep of dependencies) {
    const node = kind === "requirement" ? dep.requirement : dep.task;
    if (!node || UUID_RE.test(node) || UUID_RE.test(dep.dependsOn)) continue;
    const edges = graph.get(node) ?? [];
    edges.push(dep.dependsOn);
    graph.set(node, edges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new ValidationError(`Plan ${kind} dependencies contain a cycle at ${node}`);
    }
    visiting.add(node);
    for (const next of graph.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) visit(node);
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
    warnings.push("Plan creates todo tasks under draft requirements. Requirement-lane daemons may pick non-terminal requirements unless scheduling is constrained.");
  }
  return warnings;
}
