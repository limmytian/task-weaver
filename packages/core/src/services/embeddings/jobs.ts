import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  type Database,
  documentEmbeddingStates,
  documentEmbeddings,
  documents,
  embeddingDocumentChunks,
  embeddingGenerations,
  embeddingJobItems,
  embeddingJobs,
  embeddingProfiles,
} from "@task-weaver/db";
import type { Actor } from "../../schemas/common";
import type { CreateEmbeddingJobInput } from "../../schemas/embeddings";
import { EmbeddingProviderError, type EmbeddingProvider } from "./provider";
import {
  hashDocumentEmbeddingContent,
  planDocumentEmbedding,
  type EmbeddingDocumentSource,
} from "./chunking";

const DEFAULT_LEASE_SECONDS = 90;

export class EmbeddingJobError extends Error {
  constructor(message: string, readonly code = "job_error") {
    super(message);
    this.name = "EmbeddingJobError";
  }
}

export function profileDocumentsCondition(profile: typeof embeddingProfiles.$inferSelect) {
  if (profile.scope === "project" && profile.projectId) {
    return eq(documents.projectId, profile.projectId);
  }
  if (profile.scope === "personal" && profile.personalOwnerId && profile.personalOwnerType) {
    return and(
      isNull(documents.projectId),
      eq(documents.personalOwnerId, profile.personalOwnerId),
      eq(documents.personalOwnerType, profile.personalOwnerType),
    );
  }
  return and(isNull(documents.projectId), isNull(documents.personalOwnerId));
}

export function embeddingProfileMatchesDocument(
  profile: typeof embeddingProfiles.$inferSelect,
  document: Pick<EmbeddingDocumentSource, "projectId" | "personalOwnerId" | "personalOwnerType">,
) {
  if (profile.scope === "global") {
    return !document.projectId && !document.personalOwnerId;
  }
  if (profile.scope === "project") {
    return Boolean(profile.projectId && document.projectId === profile.projectId)
      && !document.personalOwnerId;
  }
  return Boolean(
    profile.personalOwnerId
      && profile.personalOwnerType
      && document.personalOwnerId === profile.personalOwnerId
      && document.personalOwnerType === profile.personalOwnerType
      && !document.projectId,
  );
}

async function matchingProfilesForDocument(db: Database, document: EmbeddingDocumentSource) {
  const candidates = await db.query.embeddingProfiles.findMany();
  return candidates.filter((profile) => embeddingProfileMatchesDocument(profile, document));
}

export async function reconcileDeletedDocumentEmbedding(
  db: Database,
  document: EmbeddingDocumentSource,
  actor: Actor,
) {
  const profiles = await matchingProfilesForDocument(db, document);
  for (const profile of profiles) {
    await enqueueDeletedDocument(db, profile.id, document.id, actor);
  }
  return profiles.map((profile) => profile.id);
}

async function getProfile(db: Database, profileId: string) {
  const profile = await db.query.embeddingProfiles.findFirst({
    where: eq(embeddingProfiles.id, profileId),
  });
  if (!profile) throw new EmbeddingJobError("Embedding profile not found", "profile_not_found");
  return profile;
}

async function getGeneration(db: Database, generationId: string) {
  const generation = await db.query.embeddingGenerations.findFirst({
    where: eq(embeddingGenerations.id, generationId),
  });
  if (!generation) throw new EmbeddingJobError("Embedding generation not found", "generation_not_found");
  return generation;
}

async function refreshJobProgress(db: Database, jobId: string) {
  const items = await db.query.embeddingJobItems.findMany({
    where: eq(embeddingJobItems.jobId, jobId),
  });
  const counts = {
    totalItems: items.length,
    pendingItems: items.filter((item) => item.status === "pending" || item.status === "running").length,
    completedItems: items.filter((item) => item.status === "completed").length,
    failedItems: items.filter((item) => item.status === "failed").length,
    skippedItems: items.filter((item) => item.status === "skipped" || item.status === "cancelled").length,
  };
  const [job] = await db
    .update(embeddingJobs)
    .set({ ...counts, updatedAt: new Date() })
    .where(eq(embeddingJobs.id, jobId))
    .returning();
  return job ?? null;
}

export async function refreshEmbeddingGenerationCoverage(db: Database, generationId: string) {
  const states = await db.query.documentEmbeddingStates.findMany({
    where: eq(documentEmbeddingStates.generationId, generationId),
  });
  const chunks = await db.query.embeddingDocumentChunks.findMany({
    where: eq(embeddingDocumentChunks.generationId, generationId),
    columns: { id: true },
  });
  const embeddings = await db.query.documentEmbeddings.findMany({
    where: eq(documentEmbeddings.generationId, generationId),
    columns: { id: true },
  });
  const [updated] = await db.update(embeddingGenerations)
    .set({
      totalDocuments: states.length,
      coveredDocuments: states.filter((state) => state.state === "complete").length,
      totalChunks: chunks.length,
      embeddedChunks: embeddings.length,
      failedChunks: states.reduce((total, state) => total + state.failedChunks, 0),
    })
    .where(eq(embeddingGenerations.id, generationId))
    .returning();
  return updated ?? null;
}

export async function createEmbeddingJob(
  db: Database,
  input: CreateEmbeddingJobInput,
  actor: Actor,
) {
  const profile = await getProfile(db, input.profileId);
  const generation = input.generationId ? await getGeneration(db, input.generationId) : null;
  if (generation && generation.profileId !== profile.id) {
    throw new EmbeddingJobError("Embedding generation does not belong to profile", "scope_mismatch");
  }
  if (input.kind !== "incremental" && !generation) {
    throw new EmbeddingJobError("Full and forced jobs require a target generation", "generation_required");
  }

  const [job] = await db
    .insert(embeddingJobs)
    .values({
      profileId: profile.id,
      generationId: generation?.id ?? null,
      kind: input.kind,
      status: "queued",
      configurationHash: generation?.configurationHash ?? profile.configurationHash,
      requestedBy: actor.id,
      requestedByType: actor.type,
      requestReason: input.requestReason,
      maxRetries: input.maxRetries,
    })
    .returning();
  if (!job) throw new EmbeddingJobError("Unable to create embedding job");

  if (input.kind === "full" || input.kind === "forced") {
    const scopedDocuments = await db.query.documents.findMany({
      where: profileDocumentsCondition(profile),
      columns: { id: true, version: true, content: true, title: true },
    });
    if (scopedDocuments.length > 0) {
      await db.insert(embeddingJobItems).values(
        scopedDocuments.map((document) => ({
          jobId: job.id,
          documentId: document.id,
          action: "upsert" as const,
          documentVersion: document.version,
          contentHash: hashDocumentEmbeddingContent(document),
        })),
      );
    }
    await db.update(embeddingGenerations)
      .set({ totalDocuments: scopedDocuments.length })
      .where(eq(embeddingGenerations.id, generation!.id));
  }
  return (await refreshJobProgress(db, job.id)) ?? job;
}

async function findActiveIncrementalJob(db: Database, profileId: string, generationId: string | null) {
  const candidates = await db.query.embeddingJobs.findMany({
    where: and(
      eq(embeddingJobs.profileId, profileId),
      eq(embeddingJobs.kind, "incremental"),
      generationId ? eq(embeddingJobs.generationId, generationId) : isNull(embeddingJobs.generationId),
      inArray(embeddingJobs.status, ["queued", "running", "pausing", "paused", "cancelling"]),
    ),
    orderBy: [asc(embeddingJobs.createdAt)],
    limit: 1,
  });
  return candidates[0] ?? null;
}

export async function enqueueIncrementalDocument(
  db: Database,
  profileId: string,
  document: EmbeddingDocumentSource,
  actor: Actor,
) {
  const profile = await getProfile(db, profileId);
  const generationId = profile.activeGenerationId;
  let job = await findActiveIncrementalJob(db, profile.id, generationId);
  if (!job) {
    job = await createEmbeddingJob(db, {
      profileId: profile.id,
      generationId: generationId ?? undefined,
      kind: "incremental",
      maxRetries: 5,
    }, actor);
  }
  const contentHash = hashDocumentEmbeddingContent(document);
  const existing = await db.query.embeddingJobItems.findFirst({
    where: and(
      eq(embeddingJobItems.jobId, job.id),
      eq(embeddingJobItems.documentId, document.id),
      eq(embeddingJobItems.action, "upsert"),
    ),
  });
  const [item] = await db
    .insert(embeddingJobItems)
    .values({
      jobId: job.id,
      documentId: document.id,
      action: "upsert",
      status: "pending",
      documentVersion: document.version,
      contentHash,
    })
    .onConflictDoUpdate({
      target: [embeddingJobItems.jobId, embeddingJobItems.documentId, embeddingJobItems.action],
      set: {
        status: "pending",
        documentVersion: document.version,
        contentHash,
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorSummary: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  await refreshJobProgress(db, job.id);
  return { jobId: job.id, item: item!, wasExisting: Boolean(existing) };
}

export async function enqueueDeletedDocument(
  db: Database,
  profileId: string,
  documentId: string,
  actor: Actor,
) {
  const profile = await getProfile(db, profileId);
  const job = await findActiveIncrementalJob(db, profile.id, profile.activeGenerationId);
  const targetJob = job ?? await createEmbeddingJob(db, {
    profileId: profile.id,
    generationId: profile.activeGenerationId ?? undefined,
    kind: "incremental",
    maxRetries: 5,
  }, actor);
  const [item] = await db
    .insert(embeddingJobItems)
    .values({ jobId: targetJob.id, documentId, action: "delete", status: "pending" })
    .onConflictDoUpdate({
      target: [embeddingJobItems.jobId, embeddingJobItems.documentId, embeddingJobItems.action],
      set: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorSummary: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  await refreshJobProgress(db, targetJob.id);
  return { jobId: targetJob.id, item: item! };
}

export async function reconcileDocumentEmbeddingCoverage(
  db: Database,
  document: EmbeddingDocumentSource,
  actor: Actor,
) {
  const profiles = await matchingProfilesForDocument(db, document);
  const documentHash = hashDocumentEmbeddingContent(document);
  const reconciled: Array<{ profileId: string; state: string; queued: boolean }> = [];
  for (const profile of profiles) {
    const existing = await db.query.documentEmbeddingStates.findFirst({
      where: and(
        eq(documentEmbeddingStates.profileId, profile.id),
        eq(documentEmbeddingStates.documentId, document.id),
      ),
    });
    const canIndex = profile.status === "enabled" && profile.activeGenerationId !== null;
    const stateGenerationId = profile.activeGenerationId ?? existing?.generationId ?? null;
    const hasCurrentCoverage = Boolean(
      existing
        && existing.documentVersion === document.version
        && existing.contentHash === documentHash
        && (existing.generationId === profile.activeGenerationId || !canIndex),
    );
    const nextState = hasCurrentCoverage && existing?.state === "complete"
      ? "complete"
      : canIndex ? "stale" : existing?.state === "complete" ? "stale" : "missing";
    await db.insert(documentEmbeddingStates).values({
      profileId: profile.id,
      documentId: document.id,
      generationId: stateGenerationId,
      state: nextState,
      documentVersion: document.version,
      contentHash: documentHash,
      totalChunks: hasCurrentCoverage ? existing!.totalChunks : 0,
      embeddedChunks: hasCurrentCoverage ? existing!.embeddedChunks : 0,
      failedChunks: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
      observedAt: new Date(),
      reconciledAt: hasCurrentCoverage ? existing!.reconciledAt : null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [documentEmbeddingStates.profileId, documentEmbeddingStates.documentId],
      set: {
        generationId: stateGenerationId,
        state: nextState,
        documentVersion: document.version,
        contentHash: documentHash,
        totalChunks: hasCurrentCoverage ? existing!.totalChunks : 0,
        embeddedChunks: hasCurrentCoverage ? existing!.embeddedChunks : 0,
        failedChunks: 0,
        lastErrorCode: null,
        lastErrorSummary: null,
        observedAt: new Date(),
        reconciledAt: hasCurrentCoverage ? existing!.reconciledAt : null,
        updatedAt: new Date(),
      },
    });
    let queued = false;
    if (canIndex && !hasCurrentCoverage) {
      await enqueueIncrementalDocument(db, profile.id, document, actor);
      queued = true;
    }
    reconciled.push({ profileId: profile.id, state: nextState, queued });
  }
  return reconciled;
}

export async function catchUpEmbeddingProfile(db: Database, profileId: string, actor: Actor) {
  const profile = await getProfile(db, profileId);
  const scopedDocuments = await db.query.documents.findMany({
    where: profileDocumentsCondition(profile),
  });
  for (const document of scopedDocuments) {
    await reconcileDocumentEmbeddingCoverage(db, toEmbeddingDocumentSource(document), actor);
  }
  return { profileId, documents: scopedDocuments.length };
}

export async function claimEmbeddingJob(
  db: Database,
  jobId: string,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(embeddingJobs)
      .where(and(
        eq(embeddingJobs.id, jobId),
        or(
          inArray(embeddingJobs.status, ["queued", "paused"]),
          and(eq(embeddingJobs.status, "running"), or(isNull(embeddingJobs.leaseExpiresAt), lt(embeddingJobs.leaseExpiresAt, now))),
        ),
      ))
      .limit(1)
      .for("update");
    if (!candidate) return null;
    const [claimed] = await tx
      .update(embeddingJobs)
      .set({
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: candidate.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(embeddingJobs.id, candidate.id))
      .returning();
    return claimed ?? null;
  });
}

export async function heartbeatEmbeddingJob(
  db: Database,
  jobId: string,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
) {
  const now = new Date();
  const [updated] = await db
    .update(embeddingJobs)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(and(eq(embeddingJobs.id, jobId), eq(embeddingJobs.leaseOwner, workerId), eq(embeddingJobs.status, "running")))
    .returning();
  if (!updated) throw new EmbeddingJobError("Embedding job lease is not held by worker", "lease_conflict");
  return updated;
}

export async function claimEmbeddingJobItems(
  db: Database,
  jobId: string,
  workerId: string,
  limit: number,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
) {
  if (limit < 1) return [];
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ id: embeddingJobs.id, leaseOwner: embeddingJobs.leaseOwner, status: embeddingJobs.status })
      .from(embeddingJobs)
      .where(eq(embeddingJobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job || job.leaseOwner !== workerId || job.status !== "running") {
      throw new EmbeddingJobError("Embedding job lease is not held by worker", "lease_conflict");
    }
    const candidates = await tx
      .select()
      .from(embeddingJobItems)
      .where(and(
        eq(embeddingJobItems.jobId, jobId),
        or(
          and(eq(embeddingJobItems.status, "pending"), or(isNull(embeddingJobItems.nextAttemptAt), lte(embeddingJobItems.nextAttemptAt, now))),
          and(eq(embeddingJobItems.status, "running"), or(isNull(embeddingJobItems.leaseExpiresAt), lt(embeddingJobItems.leaseExpiresAt, now))),
        ),
      ))
      .orderBy(asc(embeddingJobItems.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    const ids = candidates.map((item) => item.id);
    return tx
      .update(embeddingJobItems)
      .set({
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt,
        startedAt: now,
        attempts: sql`${embeddingJobItems.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(embeddingJobItems.id, ids))
      .returning();
  });
}

export async function requeueEmbeddingJobItem(
  db: Database,
  input: {
    itemId: string;
    workerId: string;
    documentVersion: number;
    contentHash: string;
    delayMs?: number;
  },
) {
  const [item] = await db
    .update(embeddingJobItems)
    .set({
      status: "pending",
      documentVersion: input.documentVersion,
      contentHash: input.contentHash,
      nextAttemptAt: new Date(Date.now() + (input.delayMs ?? 0)),
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(embeddingJobItems.id, input.itemId), eq(embeddingJobItems.leaseOwner, input.workerId), eq(embeddingJobItems.status, "running")))
    .returning();
  if (!item) throw new EmbeddingJobError("Embedding job item lease is not held by worker", "lease_conflict");
  return item;
}

export async function completeEmbeddingJobItem(
  db: Database,
  input: {
    itemId: string;
    workerId: string;
    success: boolean;
    retryable?: boolean;
    errorCode?: string;
    errorSummary?: string;
    promptTokens?: number;
    retryAfterMs?: number;
  },
) {
  const current = await db.query.embeddingJobItems.findFirst({ where: eq(embeddingJobItems.id, input.itemId) });
  if (!current || current.leaseOwner !== input.workerId || current.status !== "running") {
    throw new EmbeddingJobError("Embedding job item lease is not held by worker", "lease_conflict");
  }
  const shouldRetry = !input.success && input.retryable === true && current.attempts < 100;
  const now = new Date();
  const backoffMs = input.retryAfterMs
    ?? Math.min(15 * 60_000, 1_000 * (2 ** Math.min(current.attempts, 10)));
  const [item] = await db
    .update(embeddingJobItems)
    .set(shouldRetry ? {
      status: "pending",
      nextAttemptAt: new Date(now.getTime() + backoffMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: input.errorCode,
      errorSummary: input.errorSummary?.slice(0, 500),
      updatedAt: now,
    } : {
      status: input.success ? "completed" : "failed",
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: input.success ? null : input.errorCode,
      errorSummary: input.success ? null : input.errorSummary?.slice(0, 500),
      updatedAt: now,
    })
    .where(and(eq(embeddingJobItems.id, input.itemId), eq(embeddingJobItems.leaseOwner, input.workerId), eq(embeddingJobItems.status, "running")))
    .returning();
  if (!item) throw new EmbeddingJobError("Embedding job item lease was lost", "lease_conflict");

  if (input.promptTokens && input.promptTokens > 0) {
    await db.update(embeddingJobs)
      .set({ promptTokens: sql`${embeddingJobs.promptTokens} + ${input.promptTokens}`, updatedAt: now })
      .where(eq(embeddingJobs.id, item.jobId));
  }
  if (shouldRetry) {
    await db.update(embeddingJobs)
      .set({ retryCount: sql`${embeddingJobs.retryCount} + 1`, updatedAt: now })
      .where(eq(embeddingJobs.id, item.jobId));
  }
  const job = await refreshJobProgress(db, item.jobId);
  if (job && job.status === "running" && job.pendingItems === 0) {
    const terminalStatus = job.failedItems > 0 ? "failed" : "completed";
    const [completed] = await db
      .update(embeddingJobs)
      .set({ status: terminalStatus, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(embeddingJobs.id, job.id), eq(embeddingJobs.status, "running")))
      .returning();
    return { item, job: completed ?? job };
  }
  return { item, job };
}

export async function requestEmbeddingJobCancellation(db: Database, jobId: string, actorId: string) {
  const [job] = await db
    .update(embeddingJobs)
    .set({ status: "cancelling", cancelRequestedAt: new Date(), errorSummary: `Cancellation requested by ${actorId}`, updatedAt: new Date() })
    .where(and(
      eq(embeddingJobs.id, jobId),
      inArray(embeddingJobs.status, ["queued", "running", "paused", "pausing"]),
    ))
    .returning();
  return job ?? null;
}

export async function resumeEmbeddingJob(db: Database, jobId: string, actorId: string) {
  const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, jobId) });
  if (!job) throw new EmbeddingJobError("Embedding job not found", "job_not_found");
  if (job.status !== "failed" && job.status !== "paused") {
    throw new EmbeddingJobError("Only failed or paused embedding jobs can resume", "invalid_status");
  }
  await db.update(embeddingJobItems)
    .set({ status: "pending", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: new Date() })
    .where(and(eq(embeddingJobItems.jobId, job.id), inArray(embeddingJobItems.status, ["failed", "running"])));
  const [resumed] = await db.update(embeddingJobs)
    .set({ status: "queued", errorCode: null, errorSummary: `Resumed by ${actorId}`, completedAt: null, updatedAt: new Date() })
    .where(and(eq(embeddingJobs.id, job.id), inArray(embeddingJobs.status, ["failed", "paused"])))
    .returning();
  return resumed ?? null;
}

export async function retryFailedEmbeddingJobItems(db: Database, jobId: string, actorId: string) {
  const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, jobId) });
  if (!job) throw new EmbeddingJobError("Embedding job not found", "job_not_found");
  const [updated] = await db.update(embeddingJobItems)
    .set({ status: "pending", nextAttemptAt: null, errorCode: null, errorSummary: null, updatedAt: new Date() })
    .where(and(eq(embeddingJobItems.jobId, job.id), eq(embeddingJobItems.status, "failed")))
    .returning({ id: embeddingJobItems.id });
  await db.update(embeddingJobs)
    .set({ status: "queued", errorCode: null, errorSummary: `Failed items retried by ${actorId}`, completedAt: null, updatedAt: new Date() })
    .where(and(eq(embeddingJobs.id, job.id), eq(embeddingJobs.status, "failed")));
  await refreshJobProgress(db, job.id);
  return updated?.id ?? null;
}

export async function recoverExpiredEmbeddingJobs(db: Database, now = new Date()) {
  const expiredJobs = await db.query.embeddingJobs.findMany({
    where: and(eq(embeddingJobs.status, "running"), lt(embeddingJobs.leaseExpiresAt, now)),
    columns: { id: true },
  });
  for (const job of expiredJobs) {
    await db.update(embeddingJobItems)
      .set({ status: "pending", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(embeddingJobItems.jobId, job.id), eq(embeddingJobItems.status, "running"), lt(embeddingJobItems.leaseExpiresAt, now)));
    await db.update(embeddingJobs)
      .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: now })
      .where(and(eq(embeddingJobs.id, job.id), eq(embeddingJobs.status, "running")));
  }
  return expiredJobs.length;
}

function toEmbeddingDocumentSource(document: typeof documents.$inferSelect): EmbeddingDocumentSource {
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    projectId: document.projectId,
    personalOwnerId: document.personalOwnerId,
    personalOwnerType: document.personalOwnerType,
    version: document.version,
  };
}

async function runWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item) await worker(item);
    }
  }));
}

async function processEmbeddingItem(
  db: Database,
  job: typeof embeddingJobs.$inferSelect,
  item: typeof embeddingJobItems.$inferSelect,
  workerId: string,
  provider: EmbeddingProvider,
) {
  if (item.action === "delete") {
    if (job.generationId) {
      await db.delete(embeddingDocumentChunks).where(and(
        eq(embeddingDocumentChunks.generationId, job.generationId),
        eq(embeddingDocumentChunks.documentId, item.documentId),
      ));
    }
    await db.delete(documentEmbeddingStates).where(and(
      eq(documentEmbeddingStates.profileId, job.profileId),
      eq(documentEmbeddingStates.documentId, item.documentId),
    ));
    await completeEmbeddingJobItem(db, { itemId: item.id, workerId, success: true });
    return;
  }
  if (!job.generationId) {
    await completeEmbeddingJobItem(db, {
      itemId: item.id,
      workerId,
      success: false,
      errorCode: "generation_required",
      errorSummary: "Embedding job has no target generation",
    });
    return;
  }
  const document = await db.query.documents.findFirst({ where: eq(documents.id, item.documentId) });
  if (!document) {
    await completeEmbeddingJobItem(db, { itemId: item.id, workerId, success: true });
    return;
  }
  const generation = await db.query.embeddingGenerations.findFirst({ where: eq(embeddingGenerations.id, job.generationId) });
  if (!generation) {
    await completeEmbeddingJobItem(db, {
      itemId: item.id,
      workerId,
      success: false,
      errorCode: "generation_not_found",
      errorSummary: "Embedding generation was removed",
    });
    return;
  }

  const plan = planDocumentEmbedding(toEmbeddingDocumentSource(document), {
    chunkSize: generation.chunkSize,
    chunkOverlap: generation.chunkOverlap,
  });
  const result = await provider.embed({
    operationId: `job-${job.id}-item-${item.id}`,
    inputs: plan.chunks.map((chunk) => ({ id: chunk.id, text: chunk.content })),
  });
  const vectors = new Map(result.vectors.map((vector) => [vector.id, vector.embedding]));
  if (vectors.size !== plan.chunks.length || plan.chunks.some((chunk) => !vectors.has(chunk.id))) {
    throw new EmbeddingProviderError("Embedding provider returned vectors for the wrong chunks", {
      code: "invalid_response",
    });
  }

  const currentDocument = await db.query.documents.findFirst({ where: eq(documents.id, document.id) });
  if (!currentDocument || currentDocument.version !== document.version || hashDocumentEmbeddingContent(currentDocument) !== plan.documentHash) {
    const latest = currentDocument ?? document;
    await requeueEmbeddingJobItem(db, {
      itemId: item.id,
      workerId,
      documentVersion: latest.version,
      contentHash: hashDocumentEmbeddingContent(latest),
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(embeddingDocumentChunks).where(and(
      eq(embeddingDocumentChunks.generationId, generation.id),
      eq(embeddingDocumentChunks.documentId, document.id),
    ));
    if (plan.chunks.length > 0) {
      await tx.insert(embeddingDocumentChunks).values(plan.chunks.map((chunk) => ({
        id: chunk.id,
        generationId: generation.id,
        documentId: document.id,
        documentVersion: document.version,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: chunk.contentHash,
        tokenCount: chunk.tokenCount,
        characterStart: chunk.characterStart,
        characterEnd: chunk.characterEnd,
        scope: plan.scope.scope,
        projectId: plan.scope.projectId,
        personalOwnerId: plan.scope.personalOwnerId,
        personalOwnerType: plan.scope.personalOwnerType,
      })));
      await tx.insert(documentEmbeddings).values(plan.chunks.map((chunk) => ({
        generationId: generation.id,
        chunkId: chunk.id,
        embedding: vectors.get(chunk.id)!,
        dimensions: generation.dimensions,
        contentHash: chunk.contentHash,
        providerRequestId: result.requestIds[0] ?? null,
        usageTokens: result.usage?.promptTokens ?? null,
      })));
    }
    await tx.insert(documentEmbeddingStates).values({
      profileId: job.profileId,
      documentId: document.id,
      generationId: generation.id,
      state: "complete",
      documentVersion: document.version,
      contentHash: plan.documentHash,
      totalChunks: plan.chunks.length,
      embeddedChunks: plan.chunks.length,
      failedChunks: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
      reconciledAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [documentEmbeddingStates.profileId, documentEmbeddingStates.documentId],
      set: {
        generationId: generation.id,
        state: "complete",
        documentVersion: document.version,
        contentHash: plan.documentHash,
        totalChunks: plan.chunks.length,
        embeddedChunks: plan.chunks.length,
        failedChunks: 0,
        lastErrorCode: null,
        lastErrorSummary: null,
        reconciledAt: new Date(),
        updatedAt: new Date(),
      },
    });
  });
  await completeEmbeddingJobItem(db, {
    itemId: item.id,
    workerId,
    success: true,
    promptTokens: result.usage?.promptTokens,
  });
}

export async function processEmbeddingJob(
  db: Database,
  input: {
    jobId: string;
    workerId: string;
    provider: EmbeddingProvider;
    itemBatchSize?: number;
    concurrency?: number;
  },
) {
  const job = await claimEmbeddingJob(db, input.jobId, input.workerId);
  if (!job) throw new EmbeddingJobError("Embedding job is not claimable", "lease_conflict");
  let processed = 0;
  const batchSize = Math.max(1, Math.min(input.itemBatchSize ?? 16, 100));
  while (true) {
    await heartbeatEmbeddingJob(db, job.id, input.workerId);
    const current = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, job.id) });
    if (!current || current.status === "cancelling") {
      await db.update(embeddingJobItems)
        .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(embeddingJobItems.jobId, job.id), inArray(embeddingJobItems.status, ["pending", "running"])));
      await db.update(embeddingJobs)
        .set({ status: "cancelled", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(eq(embeddingJobs.id, job.id));
      break;
    }
    const items = await claimEmbeddingJobItems(db, job.id, input.workerId, batchSize);
    if (items.length === 0) {
      await refreshJobProgress(db, job.id);
      const finished = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, job.id) });
      if (finished?.pendingItems === 0) {
        await db.update(embeddingJobs)
          .set({
            status: finished.failedItems > 0 ? "failed" : "completed",
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(embeddingJobs.id, job.id), eq(embeddingJobs.status, "running")));
        break;
      }
      break;
    }
    await runWithConcurrency(items, input.concurrency ?? 2, async (item) => {
      try {
        await processEmbeddingItem(db, current, item, input.workerId, input.provider);
      } catch (error) {
        const normalized = error instanceof EmbeddingProviderError
          ? error
          : new EmbeddingJobError("Embedding item processing failed", "item_failed");
        await completeEmbeddingJobItem(db, {
          itemId: item.id,
          workerId: input.workerId,
          success: false,
          retryable: normalized instanceof EmbeddingProviderError ? normalized.retryable : true,
          errorCode: normalized instanceof EmbeddingProviderError ? normalized.code : normalized.code,
          errorSummary: normalized.message,
          retryAfterMs: normalized instanceof EmbeddingProviderError ? normalized.retryAfterMs : undefined,
        });
      }
    });
    processed += items.length;
    if (job.generationId) await refreshEmbeddingGenerationCoverage(db, job.generationId);
  }
  if (job.generationId) await refreshEmbeddingGenerationCoverage(db, job.generationId);
  return (await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, job.id) })) ?? job;
}

export async function getEmbeddingJob(db: Database, jobId: string) {
  return db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, jobId) });
}

export async function listEmbeddingJobItems(db: Database, jobId: string) {
  return db.query.embeddingJobItems.findMany({
    where: eq(embeddingJobItems.jobId, jobId),
    orderBy: [asc(embeddingJobItems.createdAt)],
  });
}

/** Aggregate provider usage without exposing request payloads or secret material. */
export async function getEmbeddingUsage(db: Database, profileId: string) {
  const [jobUsage] = await db
    .select({
      jobCount: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${embeddingJobs.promptTokens}), 0)`,
    })
    .from(embeddingJobs)
    .where(eq(embeddingJobs.profileId, profileId));
  const [vectorUsage] = await db
    .select({
      embeddedChunks: sql<number>`count(${documentEmbeddings.id})`,
      usageTokens: sql<number>`coalesce(sum(${documentEmbeddings.usageTokens}), 0)`,
    })
    .from(documentEmbeddings)
    .innerJoin(embeddingGenerations, eq(embeddingGenerations.id, documentEmbeddings.generationId))
    .where(eq(embeddingGenerations.profileId, profileId));
  return {
    profileId,
    jobCount: Number(jobUsage?.jobCount ?? 0),
    promptTokens: Number(jobUsage?.promptTokens ?? 0),
    embeddedChunks: Number(vectorUsage?.embeddedChunks ?? 0),
    usageTokens: Number(vectorUsage?.usageTokens ?? 0),
  };
}
