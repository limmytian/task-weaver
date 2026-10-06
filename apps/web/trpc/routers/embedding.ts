import { z } from "zod";
import { router, ordinaryResourceProcedure } from "../init";
import {
  createEmbeddingProfileSchema,
  embeddingJobKindSchema,
  createResourceServices,
  updateEmbeddingProfileSchema,
} from "@task-weaver/core";


export const embeddingRouter = router({
  list: ordinaryResourceProcedure
    .query(async ({ ctx }) => createResourceServices(ctx.identity).embeddingService.listEmbeddingProfiles(ctx.db)),

  get: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.getEmbeddingProfile(ctx.db, input.id)),

  create: ordinaryResourceProcedure
    .input(createEmbeddingProfileSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.createEmbeddingProfile(ctx.db, input, ctx.actor)),

  update: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateEmbeddingProfileSchema }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.updateEmbeddingProfile(ctx.db, input.id, input.data, ctx.actor)),

  test: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).embeddingService.testEmbeddingProfile(ctx.db, input.id);
    }),

  enable: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).embeddingService.enableEmbeddingProfile(ctx.db, input.id, ctx.actor);
    }),

  disable: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.setEmbeddingProfileStatus(ctx.db, input.id, "disabled", ctx.actor)),

  preview: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.previewEmbeddingRebuild(ctx.db, input.id)),

  usage: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.getEmbeddingUsage(ctx.db, input.id)),

  generations: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.listEmbeddingGenerations(ctx.db, input.id)),

  activateGeneration: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.markEmbeddingGenerationActive(ctx.db, input.id, ctx.actor)),

  rebuild: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid(), kind: embeddingJobKindSchema.exclude(["incremental"]).default("full") }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.startEmbeddingRebuild(ctx.db, input.id, input.kind, ctx.actor)),

  cleanup: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({
      deletedGenerations: await createResourceServices(ctx.identity).embeddingService.cleanupRetiredEmbeddingGenerations(ctx.db, input.id),
    })),

  job: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.getEmbeddingJob(ctx.db, input.id)),

  jobItems: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.listEmbeddingJobItems(ctx.db, input.id)),

  cancelJob: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.requestEmbeddingJobCancellation(ctx.db, input.id, ctx.actor.id)),

  resumeJob: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.resumeEmbeddingJob(ctx.db, input.id, ctx.actor.id)),

  retryFailed: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).embeddingService.retryFailedEmbeddingJobItems(ctx.db, input.id, ctx.actor.id)),
});
