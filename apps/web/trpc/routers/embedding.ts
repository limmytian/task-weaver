import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  createEmbeddingProfileSchema,
  embeddingJobKindSchema,
  embeddingService,
  updateEmbeddingProfileSchema,
  createOpenAICompatibleEmbeddingProvider,
  resolveEmbeddingSecretReference,
} from "@task-weaver/core";

function providerForProfile(profile: Awaited<ReturnType<typeof embeddingService.getEmbeddingProfile>>) {
  return createOpenAICompatibleEmbeddingProvider({
    provider: "openai_compatible",
    baseUrl: profile.baseUrl,
    model: profile.model,
    dimensions: profile.dimensions,
    secretRef: profile.secretRef,
    timeoutMs: profile.timeoutMs,
    batchSize: profile.batchSize,
  }, { resolveSecret: resolveEmbeddingSecretReference });
}

export const embeddingRouter = router({
  list: resourceProcedure
    .query(async ({ ctx }) => embeddingService.listEmbeddingProfiles(ctx.db)),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.getEmbeddingProfile(ctx.db, input.id)),

  create: resourceProcedure
    .input(createEmbeddingProfileSchema)
    .mutation(async ({ ctx, input }) => embeddingService.createEmbeddingProfile(ctx.db, input, ctx.actor)),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateEmbeddingProfileSchema }))
    .mutation(async ({ ctx, input }) => embeddingService.updateEmbeddingProfile(ctx.db, input.id, input.data, ctx.actor)),

  test: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const profile = await embeddingService.getEmbeddingProfile(ctx.db, input.id);
      return { ok: true, capabilities: await providerForProfile(profile).validateConfiguration() };
    }),

  enable: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const profile = await embeddingService.getEmbeddingProfile(ctx.db, input.id);
      return embeddingService.enableEmbeddingProfile(ctx.db, profile.id, ctx.actor, providerForProfile(profile));
    }),

  disable: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => embeddingService.setEmbeddingProfileStatus(ctx.db, input.id, "disabled", ctx.actor)),

  preview: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.previewEmbeddingRebuild(ctx.db, input.id)),

  usage: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.getEmbeddingUsage(ctx.db, input.id)),

  generations: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.listEmbeddingGenerations(ctx.db, input.id)),

  activateGeneration: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => embeddingService.markEmbeddingGenerationActive(ctx.db, input.id, ctx.actor)),

  rebuild: resourceProcedure
    .input(z.object({ id: z.string().uuid(), kind: embeddingJobKindSchema.exclude(["incremental"]).default("full") }))
    .mutation(async ({ ctx, input }) => embeddingService.startEmbeddingRebuild(ctx.db, input.id, input.kind, ctx.actor)),

  cleanup: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({
      deletedGenerations: await embeddingService.cleanupRetiredEmbeddingGenerations(ctx.db, input.id),
    })),

  job: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.getEmbeddingJob(ctx.db, input.id)),

  jobItems: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => embeddingService.listEmbeddingJobItems(ctx.db, input.id)),

  cancelJob: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => embeddingService.requestEmbeddingJobCancellation(ctx.db, input.id, ctx.actor.id)),

  resumeJob: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => embeddingService.resumeEmbeddingJob(ctx.db, input.id, ctx.actor.id)),

  retryFailed: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => embeddingService.retryFailedEmbeddingJobItems(ctx.db, input.id, ctx.actor.id)),
});
