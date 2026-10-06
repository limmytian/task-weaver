import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  type Database,
  activityLog,
  documentEmbeddingStates,
  embeddingGenerations,
  embeddingProfiles,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import {
  createEmbeddingProfileSchema,
  type CreateEmbeddingProfileInput,
  type UpdateEmbeddingProfileInput,
  updateEmbeddingProfileSchema,
} from "@task-weaver/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@task-weaver/contracts";
import {
  assertEmbeddingGenerationTransition,
  assertEmbeddingProfileTransition,
} from "./lifecycle";
import { catchUpEmbeddingProfile, createEmbeddingJob, profileDocumentsCondition } from "./jobs";
import type { EmbeddingProvider } from "./provider";

function configurationHash(input: {
  provider: "openai_compatible";
  baseUrl: string;
  model: string;
  dimensions: number;
  secretRef: string;
  timeoutMs: number;
  batchSize: number;
  maxConcurrency: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkingVersion: string;
}) {
  const canonical = JSON.stringify({
    provider: input.provider,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    model: input.model,
    dimensions: input.dimensions,
    secretRef: input.secretRef,
    timeoutMs: input.timeoutMs,
    batchSize: input.batchSize,
    maxConcurrency: input.maxConcurrency,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    chunkingVersion: input.chunkingVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function profileConfig(input: CreateEmbeddingProfileInput | typeof embeddingProfiles.$inferSelect) {
  return {
    provider: "openai_compatible" as const,
    baseUrl: input.baseUrl,
    model: input.model,
    dimensions: input.dimensions,
    secretRef: input.secretRef,
    timeoutMs: input.timeoutMs,
    batchSize: input.batchSize,
    maxConcurrency: input.maxConcurrency,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    chunkingVersion: input.chunkingVersion,
  };
}

async function getProfile(db: Database, profileId: string) {
  const profile = await db.query.embeddingProfiles.findFirst({
    where: eq(embeddingProfiles.id, profileId),
  });
  if (!profile) throw new NotFoundError("Embedding profile not found");
  return profile;
}

export async function createEmbeddingProfile(
  db: Database,
  rawInput: CreateEmbeddingProfileInput,
  actor: Actor,
) {
  const input = createEmbeddingProfileSchema.parse(rawInput);
  if (input.enabled) {
    throw new ValidationError("Embedding profiles must be created disabled and enabled after validation");
  }
  const config = profileConfig(input);
  const [profile] = await db
    .insert(embeddingProfiles)
    .values({
      name: input.name,
      scope: input.scope,
      projectId: input.scope === "project" ? input.projectId : null,
      personalOwnerId: input.scope === "personal" ? input.personalOwnerId : null,
      personalOwnerType: input.scope === "personal" ? input.personalOwnerType : null,
      status: "disabled",
      provider: config.provider,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      model: config.model,
      dimensions: config.dimensions,
      secretRef: config.secretRef,
      timeoutMs: config.timeoutMs,
      batchSize: config.batchSize,
      maxConcurrency: config.maxConcurrency,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      chunkingVersion: config.chunkingVersion,
      retentionGenerations: input.retentionGenerations,
      configurationHash: configurationHash(config),
      createdBy: actor.id,
      createdByType: actor.type,
      updatedBy: actor.id,
      updatedByType: actor.type,
    })
    .returning();
  if (!profile) throw new ValidationError("Unable to create embedding profile");
  await db.insert(activityLog).values({
    entityType: "embedding_profile",
    entityId: profile.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { scope: profile.scope, provider: profile.provider, model: profile.model },
  });
  return profile;
}

export async function getEmbeddingProfile(db: Database, profileId: string) {
  return getProfile(db, profileId);
}

export async function listEmbeddingGenerations(db: Database, profileId: string) {
  await getProfile(db, profileId);
  return db.query.embeddingGenerations.findMany({
    where: eq(embeddingGenerations.profileId, profileId),
    orderBy: [desc(embeddingGenerations.generationNumber)],
  });
}

export async function listEmbeddingProfiles(db: Database, authorizedPredicate?: SQL) {
  return db.query.embeddingProfiles.findMany({
    where: authorizedPredicate,
    orderBy: [asc(embeddingProfiles.scope), asc(embeddingProfiles.name)],
  });
}

export async function updateEmbeddingProfile(
  db: Database,
  profileId: string,
  rawInput: UpdateEmbeddingProfileInput,
  actor: Actor,
) {
  const input = updateEmbeddingProfileSchema.parse(rawInput);
  const current = await getProfile(db, profileId);
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new ConflictError("Embedding profile was modified by another actor", current.version);
  }
  const next = {
    ...profileConfig(current),
    ...input,
  };
  if (next.chunkOverlap >= next.chunkSize) {
    throw new ValidationError("chunkOverlap must be smaller than chunkSize");
  }
  const nextHash = configurationHash(next);
  const configurationChanged = nextHash !== current.configurationHash;
  const [updated] = await db
    .update(embeddingProfiles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.replace(/\/+$/, "") } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
      ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : {}),
      ...(input.chunkOverlap !== undefined ? { chunkOverlap: input.chunkOverlap } : {}),
      ...(input.chunkingVersion !== undefined ? { chunkingVersion: input.chunkingVersion } : {}),
      ...(input.retentionGenerations !== undefined ? { retentionGenerations: input.retentionGenerations } : {}),
      configurationHash: nextHash,
      status: configurationChanged ? "disabled" : current.status,
      version: current.version + 1,
      updatedBy: actor.id,
      updatedByType: actor.type,
      updatedAt: new Date(),
    })
    .where(eq(embeddingProfiles.id, profileId))
    .returning();
  if (!updated) throw new NotFoundError("Embedding profile not found");
  await db.insert(activityLog).values({
    entityType: "embedding_profile",
    entityId: profileId,
    action: configurationChanged ? "configuration_changed" : "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { configurationChanged, status: updated.status },
  });
  return updated;
}

export async function setEmbeddingProfileStatus(
  db: Database,
  profileId: string,
  status: "disabled" | "enabled",
  actor: Actor,
  authorizedDocumentPredicate?: SQL,
) {
  const current = await getProfile(db, profileId);
  assertEmbeddingProfileTransition(current.status, status);
  if (status === "enabled") {
    if (!current.activeGenerationId) {
      throw new ValidationError("Embedding profile cannot be enabled without an active generation");
    }
    const generation = await db.query.embeddingGenerations.findFirst({
      where: eq(embeddingGenerations.id, current.activeGenerationId),
    });
    if (!generation || generation.status !== "active" || generation.configurationHash !== current.configurationHash) {
      throw new ValidationError("Embedding profile configuration is not validated by its active generation");
    }
  }
  const [updated] = await db
    .update(embeddingProfiles)
    .set({
      status,
      lastErrorCode: null,
      lastErrorSummary: null,
      updatedBy: actor.id,
      updatedByType: actor.type,
      updatedAt: new Date(),
      version: current.version + 1,
    })
    .where(eq(embeddingProfiles.id, profileId))
    .returning();
  if (!updated) throw new NotFoundError("Embedding profile not found");
  if (status === "enabled") await catchUpEmbeddingProfile(db, profileId, actor, authorizedDocumentPredicate);
  await db.insert(activityLog).values({
    entityType: "embedding_profile",
    entityId: profileId,
    action: status === "enabled" ? "enabled" : "disabled",
    actorId: actor.id,
    actorType: actor.type,
  });
  return updated;
}

export async function enableEmbeddingProfile(
  db: Database,
  profileId: string,
  actor: Actor,
  provider?: EmbeddingProvider,
  authorizedDocumentPredicate?: SQL,
) {
  const profile = await getProfile(db, profileId);
  try {
    if (!provider) throw new ValidationError("Embedding provider is required");
    const capabilities = await provider.validateConfiguration();
    if (capabilities.dimensions !== profile.dimensions || capabilities.model !== profile.model) {
      throw new ValidationError("Embedding provider capabilities do not match the configured profile");
    }
    await db.update(embeddingProfiles)
      .set({ lastValidatedAt: new Date(), lastErrorCode: null, lastErrorSummary: null, updatedAt: new Date() })
      .where(eq(embeddingProfiles.id, profile.id));
    return setEmbeddingProfileStatus(db, profile.id, "enabled", actor, authorizedDocumentPredicate);
  } catch (error) {
    const errorCode = error instanceof ValidationError
      ? "invalid_config"
      : error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "provider_unavailable";
    const errorSummary = error instanceof Error ? error.message : "Embedding provider validation failed";
    await db.update(embeddingProfiles)
      .set({
        status: "failed",
        lastErrorCode: errorCode,
        lastErrorSummary: errorSummary.slice(0, 500),
        updatedBy: actor.id,
        updatedByType: actor.type,
        updatedAt: new Date(),
        version: profile.version + 1,
      })
      .where(eq(embeddingProfiles.id, profile.id));
    await db.insert(activityLog).values({
      entityType: "embedding_profile",
      entityId: profile.id,
      action: "validation_failed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: { errorCode },
    });
    throw error;
  }
}

export async function createEmbeddingGeneration(
  db: Database,
  profileId: string,
  actor: Actor,
) {
  const profile = await getProfile(db, profileId);
  const existing = await db.query.embeddingGenerations.findFirst({
    where: and(
      eq(embeddingGenerations.profileId, profile.id),
      eq(embeddingGenerations.configurationHash, profile.configurationHash),
    ),
  });
  if (existing) return existing;
  const [latest] = await db
    .select({ generationNumber: sql<number>`coalesce(max(${embeddingGenerations.generationNumber}), 0)` })
    .from(embeddingGenerations)
    .where(eq(embeddingGenerations.profileId, profile.id));
  const [generation] = await db
    .insert(embeddingGenerations)
    .values({
      profileId: profile.id,
      generationNumber: Number(latest?.generationNumber ?? 0) + 1,
      status: "building",
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      dimensions: profile.dimensions,
      chunkSize: profile.chunkSize,
      chunkOverlap: profile.chunkOverlap,
      chunkingVersion: profile.chunkingVersion,
      configurationHash: profile.configurationHash,
      createdBy: actor.id,
      createdByType: actor.type,
    })
    .returning();
  if (!generation) throw new ValidationError("Unable to create embedding generation");
  await db.insert(activityLog).values({
    entityType: "embedding_generation",
    entityId: generation.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { profileId: profile.id, generationNumber: generation.generationNumber },
  });
  return generation;
}

export async function markEmbeddingGenerationActive(
  db: Database,
  generationId: string,
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const generation = await tx.query.embeddingGenerations.findFirst({
      where: eq(embeddingGenerations.id, generationId),
    });
    if (!generation) throw new NotFoundError("Embedding generation not found");
    if (generation.status !== "building") {
      if (generation.status === "active") return generation;
      throw new ValidationError("Only a building embedding generation can be activated");
    }
    const profile = await tx.query.embeddingProfiles.findFirst({
      where: eq(embeddingProfiles.id, generation.profileId),
    });
    if (!profile) throw new NotFoundError("Embedding profile not found");
    if (profile.configurationHash !== generation.configurationHash) {
      throw new ValidationError("Embedding generation is no longer the profile target");
    }
    if (profile.activeGenerationId && profile.activeGenerationId !== generation.id) {
      await tx.update(embeddingGenerations)
        .set({ status: "retired", retiredAt: new Date() })
        .where(and(eq(embeddingGenerations.id, profile.activeGenerationId), eq(embeddingGenerations.status, "active")));
    }
    assertEmbeddingGenerationTransition("building", "active");
    const now = new Date();
    const [activated] = await tx.update(embeddingGenerations)
      .set({ status: "active", activatedAt: now, buildCompletedAt: generation.buildCompletedAt ?? now })
      .where(and(eq(embeddingGenerations.id, generation.id), eq(embeddingGenerations.status, "building")))
      .returning();
    if (!activated) throw new ConflictError("Embedding generation was changed by another actor", 0);
    const [updatedProfile] = await tx.update(embeddingProfiles)
      .set({ activeGenerationId: generation.id, updatedBy: actor.id, updatedByType: actor.type, updatedAt: now, version: profile.version + 1 })
      .where(eq(embeddingProfiles.id, profile.id))
      .returning();
    await tx.insert(activityLog).values({
      entityType: "embedding_generation",
      entityId: generation.id,
      action: "activated",
      actorId: actor.id,
      actorType: actor.type,
      metadata: { profileId: profile.id, previousGenerationId: profile.activeGenerationId },
    });
    return { generation: activated, profile: updatedProfile! };
  });
}

export async function markEmbeddingGenerationFailed(
  db: Database,
  generationId: string,
  errorCode: string,
  errorSummary: string,
  actor: Actor,
) {
  const generation = await db.query.embeddingGenerations.findFirst({ where: eq(embeddingGenerations.id, generationId) });
  if (!generation) throw new NotFoundError("Embedding generation not found");
  assertEmbeddingGenerationTransition(generation.status, "failed");
  const [updated] = await db.update(embeddingGenerations)
    .set({ status: "failed", errorCode, errorSummary: errorSummary.slice(0, 500) })
    .where(and(eq(embeddingGenerations.id, generationId), eq(embeddingGenerations.status, "building")))
    .returning();
  await db.insert(activityLog).values({
    entityType: "embedding_generation",
    entityId: generationId,
    action: "failed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { errorCode },
  });
  return updated!;
}

export async function startEmbeddingRebuild(
  db: Database,
  profileId: string,
  kind: "full" | "forced",
  actor: Actor,
  authorizedDocumentPredicate?: SQL,
) {
  const generation = await createEmbeddingGeneration(db, profileId, actor);
  return createEmbeddingJob(db, {
    profileId,
    generationId: generation.id,
    kind,
    maxRetries: 5,
  }, actor, authorizedDocumentPredicate);
}

export async function previewEmbeddingRebuild(db: Database, profileId: string, authorizedDocumentPredicate?: SQL) {
  const profile = await getProfile(db, profileId);
  const scopedDocuments = await db.query.documents.findMany({ where: and(profileDocumentsCondition(profile), authorizedDocumentPredicate), columns: { id: true } });
  const states = scopedDocuments.length === 0
    ? []
    : await db.query.documentEmbeddingStates.findMany({
      where: and(eq(documentEmbeddingStates.profileId, profile.id), inArray(documentEmbeddingStates.documentId, scopedDocuments.map((document) => document.id))),
    });
  return {
    profileId,
    generationId: profile.activeGenerationId,
    totalDocuments: scopedDocuments.length,
    completeDocuments: states.filter((state) => state.state === "complete" && state.generationId === profile.activeGenerationId).length,
    staleDocuments: states.filter((state) => state.state === "stale" || state.state === "failed").length,
    missingDocuments: scopedDocuments.length - states.length,
  };
}

export async function cleanupRetiredEmbeddingGenerations(db: Database, profileId: string) {
  const profile = await getProfile(db, profileId);
  const generations = await db.query.embeddingGenerations.findMany({
    where: and(eq(embeddingGenerations.profileId, profile.id), eq(embeddingGenerations.status, "retired")),
    orderBy: [sql`${embeddingGenerations.retiredAt} DESC`],
    offset: profile.retentionGenerations,
  });
  if (generations.length > 0) {
    await db.delete(embeddingGenerations).where(inArray(embeddingGenerations.id, generations.map((generation) => generation.id)));
  }
  return generations.length;
}
