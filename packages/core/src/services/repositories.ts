import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  type Database,
  activityLog,
  executionSlices,
  repositories,
  requirementRepositories,
  requirements,
  reviewRuns,
  taskRepositories,
  tasks,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  AddRequirementRepositoryInput,
  AddTaskRepositoryInput,
  CreateRepositoryInput,
  ListRepositoriesInput,
  RepositoryReadinessInput,
  RepositoryDeliveryStatus,
  ReopenRequirementRepositoryDeliveryInput,
  SyncRequirementRepositoryForgeStateInput,
  UpdateRepositoryInput,
  UpdateRequirementRepositoryDeliveryInput,
} from "@task-weaver/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@task-weaver/contracts";
import { assertRequirementLease } from "./claims";
import { emit } from "@task-weaver/realtime";
import {
  REPOSITORY_DELIVERY_STATE_POLICY,
  assertRepositoryDeliveryStatusTransition,
  assertRequirementStatusTransition,
  canTransitionRequirementStatus,
  classifyDaemonOutcome,
  daemonRoleForPhase,
  firstIncompleteRepositoryOperation,
  isTerminalRepositoryDeliveryStatus,
  planRepositoryRetry,
  requirementStatePolicy,
} from "./daemon-state-machine";
import {
  assertIndependentDeliveryIdentity,
  getEffectiveReviewPolicy,
} from "./reviews";
import {
  evaluateForgeSyncGuard,
  mapForgeSnapshot,
  requirementStatusFromForgeDeliveries,
} from "./forge-sync";

const SECRET_URL_PATTERN = /:\/\/[^/@\s]+:[^/@\s]+@|[?&](?:access_?token|api_?key|password|secret|token)=|#/i;

export function requirementStatusForRetryPhase(phase: "execution" | "review" | "merge") {
  return phase === "review"
    ? "in_review" as const
    : phase === "merge"
      ? "ready_to_merge" as const
      : "in_progress" as const;
}

export function deliveryIdentityPhase(fields: Pick<
  UpdateRequirementRepositoryDeliveryInput,
  "deliveryStatus" | "pushStatus" | "reviewStatus" | "mergeStatus"
>) {
  return fields.deliveryStatus === "merged"
    || fields.mergeStatus === "merging"
    || fields.mergeStatus === "merged"
    ? "merge" as const
    : fields.deliveryStatus === "in_review"
      || fields.deliveryStatus === "ready_to_merge"
      || fields.reviewStatus === "in_review"
      || fields.reviewStatus === "approved"
      || fields.reviewStatus === "changes_requested"
      ? "review" as const
      : fields.pushStatus || fields.deliveryStatus
        ? "execution" as const
        : null;
}

export interface NormalizedRepositoryCoordinates {
  host: string;
  namespace: string;
  name: string;
  canonicalKey: string;
}

export function normalizeRepositoryCoordinates(input: {
  host: string;
  namespace: string;
  name: string;
}): NormalizedRepositoryCoordinates {
  if (input.host.includes("@")) {
    throw new ValidationError("Repository host must be a normalized hostname without credentials or a path");
  }
  let host = input.host.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
  host = host.replace(/^[^@/]+@/, "");
  host = host.replace(/:(80|443|22)$/, "");
  if (!host || /[/\s@?#]/.test(host)) {
    throw new ValidationError("Repository host must be a normalized hostname without credentials or a path");
  }

  const normalizePath = (value: string, label: string) => {
    const segments = value
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
      throw new ValidationError(`Repository ${label} must contain safe path segments`);
    }
    if (segments.some((segment) => /[\s@?#]/.test(segment))) {
      throw new ValidationError(`Repository ${label} contains unsupported characters`);
    }
    return segments.join("/").toLowerCase();
  };

  const namespace = normalizePath(input.namespace, "namespace");
  const name = normalizePath(input.name.replace(/\.git\/?$/i, ""), "name");
  if (name.includes("/")) throw new ValidationError("Repository name must be a single path segment");
  return { host, namespace, name, canonicalKey: `${host}/${namespace}/${name}` };
}

function assertSafeEndpoint(value: string | null | undefined) {
  if (value && SECRET_URL_PATTERN.test(value)) {
    throw new ValidationError(
      "Repository endpoints must not contain credentials, secret query parameters, or fragments",
    );
  }
}

function normalizeTags(tags: string[] | null | undefined): string[] | null | undefined {
  if (tags === undefined) return undefined;
  if (tags === null) return null;
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function visibilityCondition(actor: Actor) {
  return or(
    eq(repositories.visibility, "instance"),
    and(eq(repositories.ownerId, actor.id), eq(repositories.ownerType, actor.type)),
  )!;
}

function isDatabaseConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

export async function createRepository(db: Database, input: CreateRepositoryInput, actor: Actor) {
  const coordinates = normalizeRepositoryCoordinates(input);
  assertSafeEndpoint(input.webUrl);
  assertSafeEndpoint(input.httpsCloneUrl);
  assertSafeEndpoint(input.sshCloneUrl);

  try {
    return await db.transaction(async (tx) => {
      const [repository] = await tx
        .insert(repositories)
        .values({
          displayName: input.displayName ?? coordinates.name,
          description: input.description,
          provider: input.provider,
          providerExternalId: input.providerExternalId,
          ...coordinates,
          webUrl: input.webUrl,
          httpsCloneUrl: input.httpsCloneUrl,
          sshCloneUrl: input.sshCloneUrl,
          defaultBranch: input.defaultBranch,
          tags: normalizeTags(input.tags),
          visibility: input.visibility,
          ownerId: input.visibility === "instance" ? null : input.ownerId,
          ownerType: input.visibility === "instance" ? null : input.ownerType,
          authPolicy: input.authPolicy,
          createdBy: actor.id,
        })
        .returning();
      await tx.insert(activityLog).values({
        entityType: "repository",
        entityId: repository!.id,
        action: "created",
        actorId: actor.id,
        actorType: actor.type,
        metadata: {
          canonicalKey: repository!.canonicalKey,
          provider: repository!.provider,
          visibility: repository!.visibility,
        },
      });
      return repository!;
    });
  } catch (error) {
    if (isDatabaseConflict(error)) {
      throw new ConflictError(`Repository identity already exists for ${coordinates.canonicalKey}`, 0);
    }
    throw error;
  }
}

async function getVisibleRepositoryRow(db: Database, id: string, actor: Actor) {
  const repository = await db.query.repositories.findFirst({
    where: and(eq(repositories.id, id), visibilityCondition(actor)),
  });
  if (!repository) throw new NotFoundError("Repository not found");
  return repository;
}

export async function getRepository(
  db: Database,
  id: string,
  actor: Actor,
  readinessInput: RepositoryReadinessInput = { operation: "read" },
) {
  await getVisibleRepositoryRow(db, id, actor);
  const repository = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
    with: {
      requirements: {
        with: { requirement: { with: { project: true } } },
        orderBy: (link, { desc: orderDesc }) => [orderDesc(link.updatedAt)],
      },
      tasks: {
        with: { task: { with: { requirement: true } } },
        orderBy: (link, { desc: orderDesc }) => [orderDesc(link.createdAt)],
      },
    },
  });
  return {
    ...repository!,
    readiness: await getRepositoryReadiness(db, id, actor, readinessInput),
  };
}

export async function listRepositories(db: Database, input: ListRepositoriesInput, actor: Actor) {
  const conditions = [visibilityCondition(actor)];
  if (input.provider) conditions.push(eq(repositories.provider, input.provider.toLowerCase()));
  if (input.host) conditions.push(eq(repositories.host, input.host.toLowerCase()));
  if (input.status) conditions.push(eq(repositories.status, input.status));
  if (input.visibility) conditions.push(eq(repositories.visibility, input.visibility));
  for (const tag of input.tags ?? []) conditions.push(sql`${tag.toLowerCase()} = ANY(${repositories.tags})`);

  const query = input.query?.trim().toLowerCase();
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(sql`(
      ${repositories.canonicalKey} ILIKE ${pattern}
      OR ${repositories.host} ILIKE ${pattern}
      OR ${repositories.namespace} ILIKE ${pattern}
      OR ${repositories.name} ILIKE ${pattern}
      OR ${repositories.displayName} ILIKE ${pattern}
      OR COALESCE(${repositories.description}, '') ILIKE ${pattern}
      OR COALESCE(${repositories.webUrl}, '') ILIKE ${pattern}
    )`);
  }

  const usageCount = sql<number>`(
    SELECT count(*)::int FROM requirement_repositories rr
    WHERE rr.repository_id = ${repositories.id}
  )`;
  const relevance = query
    ? sql<number>`CASE
        WHEN ${repositories.canonicalKey} = ${query} THEN 1000
        WHEN ${repositories.host} = ${query} THEN 900
        WHEN ${repositories.namespace} = ${query} THEN 850
        WHEN ${repositories.name} = ${query} THEN 800
        WHEN ${repositories.canonicalKey} LIKE ${`${query}%`} THEN 700
        WHEN ${repositories.name} LIKE ${`${query}%`} THEN 650
        ELSE greatest(similarity(${repositories.canonicalKey}, ${query}), similarity(${repositories.displayName}, ${query})) * 100
      END`
    : sql<number>`0`;
  const where = and(...conditions);
  const offset = (input.page - 1) * input.pageSize;
  const order = (() => {
    switch (input.sort) {
      case "recently_used": return [desc(repositories.lastUsedAt), asc(repositories.id)];
      case "usage": return [desc(usageCount), desc(repositories.lastUsedAt), asc(repositories.id)];
      case "name": return [asc(repositories.displayName), asc(repositories.id)];
      case "updated": return [desc(repositories.updatedAt), asc(repositories.id)];
      default: return query
        ? [desc(relevance), desc(usageCount), desc(repositories.lastUsedAt), asc(repositories.id)]
        : [desc(usageCount), desc(repositories.lastUsedAt), asc(repositories.id)];
    }
  })();

  const [items, totalRows] = await Promise.all([
    db.select({ repository: repositories, usageCount, relevance })
      .from(repositories).where(where).orderBy(...order).limit(input.pageSize).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(repositories).where(where),
  ]);
  const total = totalRows[0]?.count ?? 0;
  return {
    items: items.map(({ repository, usageCount: count }) => ({
      ...repository,
      usageCount: count,
      readiness: {
        state: repository.sshCloneUrl || repository.httpsCloneUrl ? "unknown" as const : "needs_configuration" as const,
        reasonCode: repository.sshCloneUrl || repository.httpsCloneUrl ? "node_context_required" : "clone_endpoint_missing",
      },
    })),
    total,
    page: input.page,
    pageSize: input.pageSize,
    pageCount: Math.ceil(total / input.pageSize),
  };
}

export async function updateRepository(db: Database, id: string, input: UpdateRepositoryInput, actor: Actor) {
  const existing = await getVisibleRepositoryRow(db, id, actor);
  assertSafeEndpoint(input.webUrl);
  assertSafeEndpoint(input.httpsCloneUrl);
  assertSafeEndpoint(input.sshCloneUrl);
  const nextVisibility = input.visibility ?? existing.visibility;
  const nextOwnerId = input.ownerId === undefined ? existing.ownerId : input.ownerId;
  const nextOwnerType = input.ownerType === undefined ? existing.ownerType : input.ownerType;
  if (nextVisibility === "instance" && (nextOwnerId || nextOwnerType)) {
    throw new ValidationError("Instance repositories cannot set an owner");
  }
  if (nextVisibility !== "instance" && (!nextOwnerId || !nextOwnerType)) {
    throw new ValidationError("Restricted repositories require ownerId and ownerType");
  }

  const coordinateChanges = input.host || input.namespace || input.name
    ? normalizeRepositoryCoordinates({
        host: input.host ?? existing.host,
        namespace: input.namespace ?? existing.namespace,
        name: input.name ?? existing.name,
      })
    : undefined;
  const fields = {
    ...input,
    ...coordinateChanges,
    tags: normalizeTags(input.tags),
    ownerId: nextVisibility === "instance" ? null : nextOwnerId,
    ownerType: nextVisibility === "instance" ? null : nextOwnerType,
    updatedAt: new Date(),
  };
  try {
    const [updated] = await db.update(repositories).set(fields).where(eq(repositories.id, id)).returning();
    await db.insert(activityLog).values({
      entityType: "repository",
      entityId: id,
      action: input.status === "archived" ? "archived" : "updated",
      actorId: actor.id,
      actorType: actor.type,
      metadata: { changedFields: Object.keys(input), previousCanonicalKey: existing.canonicalKey },
    });
    return updated!;
  } catch (error) {
    if (isDatabaseConflict(error)) throw new ConflictError("Repository identity conflicts with an existing repository", 0);
    throw error;
  }
}

export async function archiveRepository(db: Database, id: string, actor: Actor) {
  const existing = await getVisibleRepositoryRow(db, id, actor);
  const activeLinks = await db
    .select({ id: requirementRepositories.id })
    .from(requirementRepositories)
    .innerJoin(requirements, eq(requirements.id, requirementRepositories.requirementId))
    .where(and(
      eq(requirementRepositories.repositoryId, id),
      inArray(requirements.status, ["approved", "in_progress", "in_review", "ready_to_merge"]),
    ))
    .limit(1);
  if (activeLinks.length > 0) throw new ValidationError("Repository cannot be archived while active requirements depend on it");
  if (existing.status === "archived") return existing;
  return updateRepository(db, id, { status: "archived" }, actor);
}

export async function listRequirementRepositories(db: Database, requirementId: string, actor: Actor) {
  const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return db
    .select({ link: requirementRepositories, repository: repositories })
    .from(requirementRepositories)
    .innerJoin(repositories, eq(repositories.id, requirementRepositories.repositoryId))
    .where(and(eq(requirementRepositories.requirementId, requirementId), visibilityCondition(actor)))
    .orderBy(asc(repositories.canonicalKey), asc(requirementRepositories.id));
}

export async function addRequirementRepository(
  db: Database,
  requirementId: string,
  input: AddRequirementRepositoryInput,
  actor: Actor,
) {
  const [requirement, repository] = await Promise.all([
    db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) }),
    getVisibleRepositoryRow(db, input.repositoryId, actor),
  ]);
  if (!requirement) throw new NotFoundError("Requirement not found");
  if (repository.status !== "active") throw new ValidationError("Archived repositories cannot be linked");
  const [link] = await db.insert(requirementRepositories).values({
    requirementId,
    repositoryId: input.repositoryId,
    baseBranch: input.baseBranch ?? repository.defaultBranch,
    workingBranch: input.workingBranch ?? requirement.branchName,
  }).onConflictDoNothing().returning();
  const result = link ?? await db.query.requirementRepositories.findFirst({
    where: and(
      eq(requirementRepositories.requirementId, requirementId),
      eq(requirementRepositories.repositoryId, input.repositoryId),
    ),
  });
  await db.update(repositories).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(repositories.id, input.repositoryId));
  if (link) {
    await db.insert(activityLog).values({
      entityType: "requirement", entityId: requirementId, action: "repository_linked",
      actorId: actor.id, actorType: actor.type, metadata: { repositoryId: input.repositoryId },
    });
  }
  return result!;
}

export async function removeRequirementRepository(
  db: Database,
  requirementId: string,
  repositoryId: string,
  actor: Actor,
) {
  const link = await db.query.requirementRepositories.findFirst({
    where: and(
      eq(requirementRepositories.requirementId, requirementId),
      eq(requirementRepositories.repositoryId, repositoryId),
    ),
  });
  if (!link) throw new NotFoundError("Requirement repository link not found");
  const [taskReferences, runningSlices] = await Promise.all([
    db.select({ id: taskRepositories.id }).from(taskRepositories)
      .innerJoin(tasks, eq(tasks.id, taskRepositories.taskId))
      .where(and(eq(tasks.requirementId, requirementId), eq(taskRepositories.repositoryId, repositoryId))).limit(1),
    db.select({ id: executionSlices.id }).from(executionSlices)
      .where(and(eq(executionSlices.requirementId, requirementId), eq(executionSlices.status, "in_progress"))).limit(1),
  ]);
  const blockers: string[] = [];
  if (taskReferences.length > 0) blockers.push("tasks_reference_repository");
  if (runningSlices.length > 0 && link.manifestVersion !== null) blockers.push("active_slice_manifest");
  if (link.deliveryStatus !== "pending") blockers.push("delivery_state_exists");
  if (blockers.length > 0) throw new ValidationError(`Repository link cannot be removed: ${blockers.join(", ")}`);
  const [deleted] = await db.delete(requirementRepositories).where(eq(requirementRepositories.id, link.id)).returning();
  await db.insert(activityLog).values({
    entityType: "requirement", entityId: requirementId, action: "repository_unlinked",
    actorId: actor.id, actorType: actor.type, metadata: { repositoryId },
  });
  return deleted!;
}

export async function retryRequirementRepositoryDelivery(
  db: Database,
  linkId: string,
  actor: Actor,
  reason = "Retry requested by operator",
) {
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, linkId),
  });
  if (!link) throw new NotFoundError("Requirement repository delivery not found");
  if (link.deliveryStatus !== "failed") {
    throw new ValidationError("Only failed repository delivery can be retried");
  }
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, link.requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  const priorOutcome = link.failureCode
    ? classifyDaemonOutcome(link.failureCode, {
        currentPhase: requirementStatePolicy(requirement.status).phase,
        operation: "repository_delivery_retry",
      })
    : null;
  const targetPhase = link.retryPhase
    ?? priorOutcome?.targetPhase
    ?? requirementStatePolicy(requirement.status).phase;
  const retryPhase = targetPhase === "review" || targetPhase === "merge"
    ? targetPhase
    : "execution";
  const retryRole = daemonRoleForPhase(retryPhase);
  const deliveryStatus = retryPhase === "review"
    ? "in_review"
    : retryPhase === "merge"
      ? "ready_to_merge"
      : "pending";
  const requirementStatus = requirementStatusForRetryPhase(retryPhase);
  assertRequirementStatusTransition(requirement.status, requirementStatus);
  assertRepositoryDeliveryStatusTransition(link.deliveryStatus, deliveryStatus);
  const now = new Date();
  const resumeOperation = firstIncompleteRepositoryOperation(
    link.operationCheckpoints,
    link.resumeOperation,
  );
  const updated = await db.transaction(async (tx) => {
    const [delivery] = await tx.update(requirementRepositories).set({
      deliveryStatus,
      failureCode: null,
      failureSummary: null,
      retryPhase,
      retryRole,
      retryPolicy: null,
      nextAttemptAt: null,
      lastAttemptAt: now,
      resumeOperation,
      updatedAt: now,
    }).where(and(
      eq(requirementRepositories.id, linkId),
      eq(requirementRepositories.deliveryStatus, "failed"),
    )).returning();
    if (!delivery) {
      throw new ConflictError("Repository delivery changed while retry was being requested", 0);
    }
    if (requirement.status !== requirementStatus) {
      await tx.update(requirements).set({
        status: requirementStatus,
        updatedAt: now,
      }).where(eq(requirements.id, requirement.id));
    }
    await tx.insert(activityLog).values({
      entityType: "requirement",
      entityId: link.requirementId,
      action: "repository_delivery_retry_requested",
      actorId: actor.id,
      actorType: actor.type,
      metadata: {
        repositoryId: link.repositoryId,
        retryCount: link.retryCount,
        retryPhase,
        retryRole,
        retryPolicy: link.retryPolicy,
        resumeOperation,
        priorOutcome,
        reason,
        requirementStatusFrom: requirement.status,
        requirementStatusTo: requirementStatus,
      },
    });
    return delivery;
  });
  if (requirement.status !== requirementStatus) {
    emit({
      type: "requirement_updated",
      projectId: requirement.projectId,
      requirementId: requirement.id,
    });
  }
  emit({
    type: "repository_retry_requested",
    projectId: requirement.projectId,
    requirementId: requirement.id,
    requirementRepositoryId: link.id,
    repositoryId: link.repositoryId,
    targetRole: retryRole,
    targetPhase: retryPhase,
    resumeOperation,
    nextAttemptAt: null,
  });
  return {
    link: updated,
    targetRole: retryRole,
    targetPhase: retryPhase,
    requirementStatus,
    resumeOperation,
  };
}

export async function handoffRequirementRepositoryDelivery(
  db: Database,
  linkId: string,
  reason: string,
  actor: Actor,
) {
  if (actor.type !== "human") {
    throw new ValidationError("Manual repository handoff requires a human operator");
  }
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, linkId),
  });
  if (!link) throw new NotFoundError("Requirement repository delivery not found");
  if (link.deliveryStatus !== "failed") {
    throw new ValidationError("Only failed repository delivery can be handed off manually");
  }
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, link.requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");

  const now = new Date();
  const failureSummary = redactDeliverySummary(
    `${link.failureSummary ? `${link.failureSummary}\n` : ""}Manual handoff: ${reason}`,
  );
  const [updated] = await db.update(requirementRepositories).set({
    retryPolicy: "manual",
    nextAttemptAt: null,
    failureSummary,
    updatedAt: now,
  }).where(and(
    eq(requirementRepositories.id, linkId),
    eq(requirementRepositories.deliveryStatus, "failed"),
  )).returning();
  if (!updated) {
    throw new ConflictError("Repository delivery changed while manual handoff was being recorded", 0);
  }
  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: link.requirementId,
    action: "repository_delivery_manual_handoff",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      repositoryId: link.repositoryId,
      reason,
      retryPhase: link.retryPhase,
      retryRole: link.retryRole,
      retryCount: link.retryCount,
      failureCode: link.failureCode,
    },
  });
  emit({
    type: "requirement_updated",
    projectId: requirement.projectId,
    requirementId: requirement.id,
  });
  return updated;
}

export async function reopenRequirementRepositoryDelivery(
  db: Database,
  linkId: string,
  input: ReopenRequirementRepositoryDeliveryInput,
  actor: Actor,
) {
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, linkId),
  });
  if (!link) throw new NotFoundError("Requirement repository delivery not found");
  await assertRequirementLease(
    db,
    link.requirementId,
    actor,
    { leaseGeneration: input.leaseGeneration, daemonId: input.daemonId },
    true,
  );
  if (!isTerminalRepositoryDeliveryStatus(link.deliveryStatus)) {
    throw new ValidationError("Only merged or unchanged repository delivery can be explicitly reopened");
  }
  assertRepositoryDeliveryStatusTransition(
    link.deliveryStatus as RepositoryDeliveryStatus,
    "pending",
    { allowTerminalReopen: true },
  );
  const now = new Date();
  const [updated] = await db.update(requirementRepositories).set({
    workspaceKey: null,
    manifestVersion: null,
    provisionedAt: null,
    headCommit: null,
    pushedCommit: null,
    pushStatus: "pending",
    pushedAt: null,
    pullRequestProvider: null,
    pullRequestExternalId: null,
    pullRequestUrl: null,
    reviewStatus: "pending",
    mergeStatus: "pending",
    mergedAt: null,
    deliveryStatus: "pending",
    failureCode: null,
    failureSummary: null,
    retryPhase: null,
    retryRole: null,
    retryPolicy: null,
    resumeOperation: null,
    operationCheckpoints: {},
    nextAttemptAt: null,
    lastAttemptAt: now,
    updatedAt: now,
  }).where(and(
    eq(requirementRepositories.id, linkId),
    eq(requirementRepositories.deliveryStatus, link.deliveryStatus),
  )).returning();
  if (!updated) {
    throw new ConflictError("Repository delivery changed while it was being reopened", 0);
  }
  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: link.requirementId,
    action: "repository_delivery_reopened",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      repositoryId: link.repositoryId,
      previousDeliveryStatus: link.deliveryStatus,
      previousHeadCommit: link.headCommit,
      previousPushedCommit: link.pushedCommit,
      previousPullRequestUrl: link.pullRequestUrl,
      reason: input.reason,
      leaseGeneration: input.leaseGeneration,
      daemonId: input.daemonId,
    },
  });
  return updated;
}

function redactDeliverySummary(value: string | null | undefined) {
  if (value === null || value === undefined) return value;
  return value
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://[redacted]@")
    .replace(/([?&](?:access_?token|api_?key|password|secret|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:ghp|glpat|github_pat)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .slice(0, 2000);
}

export async function updateRequirementRepositoryDelivery(
  db: Database,
  linkId: string,
  input: UpdateRequirementRepositoryDeliveryInput,
  actor: Actor,
) {
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, linkId),
  });
  if (!link) throw new NotFoundError("Requirement repository link not found");
  const {
    leaseGeneration,
    daemonId,
    reviewPolicyDecision,
    reviewPolicyEvidence,
    manualOverrideReason,
    manualOverrideReference,
    operationCheckpoint,
    ...fields
  } = input;
  await assertRequirementLease(
    db,
    link.requirementId,
    actor,
    { leaseGeneration, daemonId },
    true,
  );
  if (fields.deliveryStatus) {
    assertRepositoryDeliveryStatusTransition(
      link.deliveryStatus as RepositoryDeliveryStatus,
      fields.deliveryStatus,
    );
  }
  const resultingDeliveryStatus = fields.deliveryStatus ?? link.deliveryStatus;
  if (fields.failureCode && resultingDeliveryStatus !== "failed") {
    throw new ValidationError("Repository failure codes require deliveryStatus 'failed'");
  }
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, link.requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  const actorPhase = deliveryIdentityPhase(fields);
  const policy = actorPhase === "review" || actorPhase === "merge"
    ? await getEffectiveReviewPolicy(db, link.requirementId)
    : null;
  const overrideRequested = reviewPolicyDecision === "bypassed";
  if (overrideRequested) {
    if (!policy?.allowManualOverride) {
      throw new ValidationError("Manual review policy override is disabled");
    }
    if (actor.type !== "human") {
      throw new ValidationError("Manual review policy override requires a human actor");
    }
    if (policy.overrideRequiresReason && !manualOverrideReason) {
      throw new ValidationError("Manual review policy override requires an audit reason");
    }
  }
  if (policy && (actorPhase === "review" || actorPhase === "merge")) {
    assertIndependentDeliveryIdentity(policy, actorPhase, {
      executor: {
        actorId: link.executorActorId,
        actorType: link.executorActorType,
        daemonId: link.executorDaemonId,
      },
      reviewer: {
        actorId: link.reviewerActorId,
        actorType: link.reviewerActorType,
        daemonId: link.reviewerDaemonId,
      },
      current: { actorId: actor.id, actorType: actor.type, daemonId: daemonId ?? null },
    }, overrideRequested ? { allowed: true, reason: manualOverrideReason } : undefined);
  }
  const requiresStructuredReview = Boolean(
    policy
    && (
      policy.requiredChecks.length > 0
      || policy.requireAiReview
      || policy.minimumHumanApprovals > 0
      || policy.requireIndependentReviewer
    ),
  );
  if (
    actorPhase === "review"
    && fields.deliveryStatus === "ready_to_merge"
    && requiresStructuredReview
    && !overrideRequested
  ) {
    const latestRun = await db.query.reviewRuns.findFirst({
      where: eq(reviewRuns.requirementRepositoryId, link.id),
      orderBy: desc(reviewRuns.attempt),
    });
    if (!latestRun || latestRun.status !== "approved" || latestRun.headCommit !== (fields.headCommit ?? link.headCommit)) {
      throw new ValidationError("Repository cannot become ready to merge until the current structured review run is approved");
    }
  }
  const operation = fields.mergeStatus
    ? "merge"
    : fields.reviewStatus
      ? "review"
      : fields.pushStatus
        ? "push"
        : link.deliveryStatus === "pending" || link.deliveryStatus === "provisioning"
          ? "provision"
          : "repository_delivery";
  const checkpointOperation = operationCheckpoint?.operation ?? operation;
  const outcome = fields.failureCode
    ? classifyDaemonOutcome(fields.failureCode, {
        currentPhase: requirement
          ? requirementStatePolicy(requirement.status).phase
          : REPOSITORY_DELIVERY_STATE_POLICY[link.deliveryStatus as RepositoryDeliveryStatus].phase,
        operation: checkpointOperation,
      })
    : null;
  const retryPhase: "execution" | "review" | "merge" | null = outcome?.targetPhase === "review" || outcome?.targetPhase === "merge"
    ? outcome.targetPhase
    : outcome
      ? "execution"
      : null;
  const retryAttempt = outcome ? link.retryCount + 1 : link.retryCount;
  const retryPlan = outcome
    ? planRepositoryRetry(outcome.retryPolicy, retryAttempt)
    : null;
  const persistedRetryPolicy: "automatic" | "after_follow_up" | "manual" =
    retryPlan?.effectivePolicy === "automatic" || retryPlan?.effectivePolicy === "after_follow_up"
      ? retryPlan.effectivePolicy
      : "manual";
  const nextAttemptAt = retryPlan?.delayMs
    ? new Date(Date.now() + retryPlan.delayMs)
    : null;
  const retryRoutingFields = outcome && retryPhase
    ? {
        retryCount: retryAttempt,
        retryPhase,
        retryRole: daemonRoleForPhase(retryPhase),
        retryPolicy: persistedRetryPolicy,
        resumeOperation: checkpointOperation,
        nextAttemptAt,
        lastAttemptAt: fields.lastAttemptAt ?? new Date(),
      }
    : fields.deliveryStatus && fields.deliveryStatus !== "failed"
      ? {
          retryPhase: null,
          retryRole: null,
          retryPolicy: null,
          resumeOperation: null,
          nextAttemptAt: null,
        }
      : {};
  const operationCheckpoints = operationCheckpoint
    ? {
        ...(link.operationCheckpoints ?? {}),
        [operationCheckpoint.operation]: {
          status: operationCheckpoint.status,
          attempt: retryAttempt,
          updatedAt: new Date().toISOString(),
          ...(operationCheckpoint.commit ? { commit: operationCheckpoint.commit } : {}),
          ...(operationCheckpoint.summary
            ? { summary: redactDeliverySummary(operationCheckpoint.summary) ?? operationCheckpoint.summary }
            : {}),
        },
      }
    : link.operationCheckpoints;
  const identityFields = actorPhase === "execution"
    ? {
        executorActorId: actor.id,
        executorActorType: actor.type,
        executorDaemonId: daemonId ?? null,
      }
    : actorPhase === "review"
      ? {
          reviewerActorId: actor.id,
          reviewerActorType: actor.type,
          reviewerDaemonId: daemonId ?? null,
        }
      : actorPhase === "merge"
        ? {
            mergerActorId: actor.id,
            mergerActorType: actor.type,
            mergerDaemonId: daemonId ?? null,
          }
        : {};

  const [updated] = await db.update(requirementRepositories).set({
    ...fields,
    ...retryRoutingFields,
    ...identityFields,
    operationCheckpoints,
    failureSummary: redactDeliverySummary(fields.failureSummary),
    updatedAt: new Date(),
  }).where(and(
    eq(requirementRepositories.id, linkId),
    eq(requirementRepositories.deliveryStatus, link.deliveryStatus),
  )).returning();
  if (!updated) {
    throw new ConflictError("Repository delivery changed during this update", 0);
  }
  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: link.requirementId,
    action: "repository_delivery_updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      repositoryId: link.repositoryId,
      deliveryStatus: fields.deliveryStatus,
      pushStatus: fields.pushStatus,
      reviewStatus: fields.reviewStatus,
      mergeStatus: fields.mergeStatus,
      failureCode: fields.failureCode,
      outcome,
      retryPhase,
      retryRole: retryPhase ? daemonRoleForPhase(retryPhase) : null,
      requestedRetryPolicy: retryPlan?.requestedPolicy ?? null,
      effectiveRetryPolicy: retryPlan ? persistedRetryPolicy : null,
      retryExhausted: retryPlan?.exhausted ?? false,
      resumeOperation: outcome ? checkpointOperation : null,
      operationCheckpoint,
      nextAttemptAt,
      retryCount: retryAttempt,
      leaseGeneration,
      daemonId,
      reviewPolicyDecision,
      reviewPolicyEvidence,
      mergeMode: fields.mergeMode,
      manualActionUrl: fields.manualActionUrl,
      manualOverrideReason: redactDeliverySummary(manualOverrideReason),
      manualOverrideReference,
    },
  });
  emit({
    type: "requirement_updated",
    projectId: requirement.projectId,
    requirementId: requirement.id,
  });
  return updated;
}

export async function syncRequirementRepositoryForgeState(
  db: Database,
  linkId: string,
  input: SyncRequirementRepositoryForgeStateInput,
  actor: Actor,
) {
  const link = await db.query.requirementRepositories.findFirst({
    where: eq(requirementRepositories.id, linkId),
  });
  if (!link) throw new NotFoundError("Requirement repository link not found");
  await assertRequirementLease(
    db,
    link.requirementId,
    actor,
    { daemonId: input.daemonId, leaseGeneration: input.leaseGeneration },
    Boolean(input.daemonId || input.leaseGeneration !== undefined),
  );

  const previousState = link.externalState ?? {};
  const guard = evaluateForgeSyncGuard({
    previousIdempotencyKey: previousState.idempotencyKey,
    currentRevision: link.externalSyncRevision,
    expectedRevision: input.expectedRevision,
    previousObservedAt: link.externalStateUpdatedAt,
    observedAt: input.observedAt,
    idempotencyKey: input.idempotencyKey,
  });
  if (guard.action === "idempotent") {
    return { link, idempotent: true, revision: link.externalSyncRevision };
  }
  if (guard.action === "revision_conflict") {
    throw new ConflictError(
      `Forge state revision changed from ${input.expectedRevision} to ${link.externalSyncRevision}`,
      link.externalSyncRevision,
    );
  }
  if (guard.action === "stale_observation") {
    throw new ConflictError("Forge state observation is older than the latest synchronized state", link.externalSyncRevision);
  }

  const snapshot = input.snapshot;
  if (
    link.pullRequestProvider
    && link.pullRequestProvider !== snapshot.provider
  ) {
    throw new ValidationError("Forge snapshot provider does not match the linked pull request provider");
  }
  if (
    link.pullRequestExternalId
    && link.pullRequestExternalId !== snapshot.externalId
  ) {
    throw new ValidationError("Forge snapshot pull request does not match the linked pull request");
  }

  const reviewHead = snapshot.headCommit ?? link.headCommit;
  const approvedRun = reviewHead
    ? await db.query.reviewRuns.findFirst({
        where: and(
          eq(reviewRuns.requirementRepositoryId, link.id),
          eq(reviewRuns.headCommit, reviewHead),
          eq(reviewRuns.status, "approved"),
        ),
        orderBy: desc(reviewRuns.attempt),
      })
    : null;
  const transition = mapForgeSnapshot({
    currentDeliveryStatus: link.deliveryStatus,
    currentHeadCommit: link.pushedCommit ?? link.headCommit,
    snapshot,
    currentHeadApproved: Boolean(approvedRun),
  });
  assertRepositoryDeliveryStatusTransition(link.deliveryStatus, transition.deliveryStatus);

  const nextRevision = link.externalSyncRevision + 1;
  const externalState = {
    provider: snapshot.provider,
    externalId: snapshot.externalId,
    url: snapshot.url,
    pullRequestState: snapshot.state,
    headCommit: snapshot.headCommit,
    baseCommit: snapshot.baseCommit,
    mergeable: snapshot.mergeable,
    mergeState: snapshot.mergeState,
    checks: snapshot.checks,
    approvals: snapshot.approvals,
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    observedAt: input.observedAt.toISOString(),
    idempotencyKey: input.idempotencyKey,
  };
  const [updated] = await db.update(requirementRepositories).set({
    pullRequestProvider: snapshot.provider,
    pullRequestExternalId: snapshot.externalId,
    pullRequestUrl: snapshot.url,
    externalState,
    externalStateUpdatedAt: input.observedAt,
    externalSyncRevision: nextRevision,
    deliveryStatus: transition.deliveryStatus,
    reviewStatus: transition.reviewStatus,
    mergeStatus: transition.mergeStatus,
    headCommit: transition.staleHead ? snapshot.headCommit : link.headCommit,
    pushedCommit: transition.staleHead ? snapshot.headCommit : link.pushedCommit,
    mergedAt: transition.deliveryStatus === "merged" ? link.mergedAt ?? input.observedAt : link.mergedAt,
    failureCode: transition.failureCode,
    failureSummary: transition.failureSummary,
    retryPhase: null,
    retryRole: null,
    retryPolicy: null,
    resumeOperation: null,
    nextAttemptAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(requirementRepositories.id, linkId),
    eq(requirementRepositories.externalSyncRevision, link.externalSyncRevision),
  )).returning();
  if (!updated) {
    throw new ConflictError("Forge state changed during synchronization", link.externalSyncRevision);
  }

  if (transition.invalidateReview && snapshot.headCommit) {
    await db.update(reviewRuns).set({
      status: "superseded",
      summary: `Superseded because the provider pull-request head changed to ${snapshot.headCommit}`,
      completedAt: input.observedAt,
      updatedAt: new Date(),
    }).where(and(
      eq(reviewRuns.requirementRepositoryId, link.id),
      inArray(reviewRuns.status, ["running", "approved", "changes_requested", "blocked", "failed"]),
    ));
  }

  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, link.requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  const repositoryLinks = await db.query.requirementRepositories.findMany({
    where: eq(requirementRepositories.requirementId, link.requirementId),
  });
  const desiredRequirementStatus = requirementStatusFromForgeDeliveries(
    repositoryLinks.map((repositoryLink) => repositoryLink.deliveryStatus),
  );
  if (
    requirement.status !== desiredRequirementStatus
    && canTransitionRequirementStatus(requirement.status, desiredRequirementStatus)
  ) {
    await db.update(requirements).set({
      status: desiredRequirementStatus,
      updatedAt: new Date(),
    }).where(eq(requirements.id, requirement.id));
  }

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: link.requirementId,
    action: "repository_forge_state_synchronized",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      repositoryId: link.repositoryId,
      provider: snapshot.provider,
      pullRequestExternalId: snapshot.externalId,
      pullRequestState: snapshot.state,
      pullRequestUrl: snapshot.url,
      headCommit: snapshot.headCommit,
      staleHead: transition.staleHead,
      deliveryStatus: transition.deliveryStatus,
      reviewStatus: transition.reviewStatus,
      mergeStatus: transition.mergeStatus,
      idempotencyKey: input.idempotencyKey,
      externalSyncRevision: nextRevision,
      leaseGeneration: input.leaseGeneration,
      daemonId: input.daemonId,
    },
  });
  emit({
    type: "requirement_updated",
    projectId: requirement.projectId,
    requirementId: requirement.id,
  });
  return { link: updated, idempotent: false, revision: nextRevision, transition };
}

export async function listTaskRepositories(db: Database, taskId: string, actor: Actor) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found");
  return db.select({ link: taskRepositories, repository: repositories })
    .from(taskRepositories)
    .innerJoin(repositories, eq(repositories.id, taskRepositories.repositoryId))
    .where(and(eq(taskRepositories.taskId, taskId), visibilityCondition(actor)))
    .orderBy(asc(repositories.canonicalKey), asc(taskRepositories.id));
}

export async function addTaskRepository(db: Database, taskId: string, input: AddTaskRepositoryInput, actor: Actor) {
  const [task, repository] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }),
    getVisibleRepositoryRow(db, input.repositoryId, actor),
  ]);
  if (!task) throw new NotFoundError("Task not found");
  if (task.scope !== "project" || !task.requirementId) throw new ValidationError("Only project tasks can link repositories");
  if (repository.status !== "active") throw new ValidationError("Archived repositories cannot be linked");

  return db.transaction(async (tx) => {
    const requirementLink = await tx.query.requirementRepositories.findFirst({
      where: and(
        eq(requirementRepositories.requirementId, task.requirementId!),
        eq(requirementRepositories.repositoryId, input.repositoryId),
      ),
    });
    if (!requirementLink && !input.addToRequirement) {
      throw new ValidationError(
        "Task repositories must belong to the Requirement workspace; set addToRequirement=true for the explicit expansion flow",
      );
    }
    if (!requirementLink) {
      await tx.insert(requirementRepositories).values({
        requirementId: task.requirementId!, repositoryId: input.repositoryId,
        baseBranch: input.baseBranch ?? repository.defaultBranch, workingBranch: input.workingBranch,
      });
      await tx.insert(activityLog).values({
        entityType: "requirement", entityId: task.requirementId!, action: "repository_linked",
        actorId: actor.id, actorType: actor.type,
        metadata: { repositoryId: input.repositoryId, viaTaskId: taskId, explicit: true },
      });
    }
    const [link] = await tx.insert(taskRepositories)
      .values({ taskId, repositoryId: input.repositoryId, createdBy: actor.id })
      .onConflictDoNothing().returning();
    const result = link ?? await tx.query.taskRepositories.findFirst({
      where: and(eq(taskRepositories.taskId, taskId), eq(taskRepositories.repositoryId, input.repositoryId)),
    });
    if (link) {
      await tx.insert(activityLog).values({
        entityType: "task", entityId: taskId, action: "repository_linked",
        actorId: actor.id, actorType: actor.type, metadata: { repositoryId: input.repositoryId },
      });
    }
    await tx.update(repositories).set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(repositories.id, input.repositoryId));
    return result!;
  });
}

export async function removeTaskRepository(db: Database, taskId: string, repositoryId: string, actor: Actor) {
  const [deleted] = await db.delete(taskRepositories)
    .where(and(eq(taskRepositories.taskId, taskId), eq(taskRepositories.repositoryId, repositoryId))).returning();
  if (!deleted) throw new NotFoundError("Task repository link not found");
  await db.insert(activityLog).values({
    entityType: "task", entityId: taskId, action: "repository_unlinked",
    actorId: actor.id, actorType: actor.type, metadata: { repositoryId },
  });
  return deleted;
}

export async function getRepositoryReadiness(
  db: Database,
  repositoryId: string,
  actor: Actor,
  input: RepositoryReadinessInput,
) {
  const repository = await getVisibleRepositoryRow(db, repositoryId, actor);
  const policy = repository.authPolicy ?? {};
  const allowedOperations = policy.allowedOperations ?? ["read", "push", "forge"];
  const allowedTransports = policy.allowedTransports ?? ["ssh", "https"];
  const transport = input.transport ?? policy.preferredTransport ?? (repository.sshCloneUrl ? "ssh" : "https");
  let state: "denied" | "needs_configuration" | "unknown" = "unknown";
  let reasonCode = input.nodeId ? "resolver_not_implemented" : "node_context_required";
  if (!allowedOperations.includes(input.operation) || !allowedTransports.includes(transport)) {
    state = "denied";
    reasonCode = "repository_policy_denied";
  } else if (!repository.sshCloneUrl && !repository.httpsCloneUrl) {
    state = "needs_configuration";
    reasonCode = "clone_endpoint_missing";
  } else if (policy.credentialProfileRef && input.nodeId) {
    state = "needs_configuration";
    reasonCode = "credential_profile_not_resolved";
  }
  return {
    state, transport, operation: input.operation, reasonCode,
    nodeId: input.nodeId ?? null, policyRevision: policy.revision ?? 1, checkedAt: new Date(),
  };
}

export function aggregateRequirementDelivery(
  links: Array<{ deliveryStatus: string }>,
): "none" | "pending" | "partial" | "failed" | "complete" {
  if (links.length === 0) return "none";
  const complete = links.filter((link) => isTerminalRepositoryDeliveryStatus(link.deliveryStatus)).length;
  const failed = links.some((link) => link.deliveryStatus === "failed");
  if (complete === links.length) return "complete";
  if (complete > 0) return "partial";
  if (failed) return "failed";
  return "pending";
}
