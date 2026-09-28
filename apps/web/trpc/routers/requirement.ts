import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  requirementService,
  createRequirementSchema,
  updateRequirementSchema,
  listRequirementsSchema,
  linkDocumentToRequirementSchema,
  createRequirementDependencySchema,
  createExecutionSliceSchema,
  updateExecutionSliceSchema,
} from "@task-weaver/core";

export const requirementRouter = router({
  list: publicProcedure
    .input(listRequirementsSchema)
    .query(async ({ ctx, input }) => {
      return requirementService.listRequirements(ctx.db, input);
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.getRequirement(ctx.db, input.id);
    }),

  create: publicProcedure
    .input(createRequirementSchema)
    .mutation(async ({ ctx, input }) => {
      return requirementService.createRequirement(ctx.db, input, ctx.actor);
    }),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateRequirementSchema }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.updateRequirement(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.deleteRequirement(ctx.db, input.id, ctx.actor);
    }),

  unlinkDocument: publicProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.unlinkDocumentFromRequirement(ctx.db, input.linkId);
    }),

  linkDocument: publicProcedure
    .input(
      z.object({ requirementId: z.string().uuid() }).merge(linkDocumentToRequirementSchema),
    )
    .mutation(async ({ ctx, input }) => {
      return requirementService.linkDocumentToRequirement(
        ctx.db,
        input.requirementId,
        input.documentId,
        input.linkType,
        ctx.actor,
      );
    }),

  listDependencies: publicProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.listRequirementDependencies(ctx.db, input.requirementId);
    }),

  addDependency: publicProcedure
    .input(
      z.object({ requirementId: z.string().uuid() }).merge(createRequirementDependencySchema),
    )
    .mutation(async ({ ctx, input }) => {
      return requirementService.addRequirementDependency(
        ctx.db,
        input.requirementId,
        input.dependsOnRequirementId,
        input.type,
        ctx.actor,
        input.description,
      );
    }),

  removeDependency: publicProcedure
    .input(z.object({ depId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.removeRequirementDependency(ctx.db, input.depId, ctx.actor);
    }),

  burndown: publicProcedure
    .input(z.object({ id: z.string().uuid(), days: z.number().int().min(1).max(365).optional() }))
    .query(async ({ ctx, input }) => {
      return requirementService.getRequirementBurndown(ctx.db, input.id);
    }),

  listSlices: publicProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.listExecutionSlices(ctx.db, input.requirementId);
    }),

  createSlice: publicProcedure
    .input(z.object({ requirementId: z.string().uuid() }).merge(createExecutionSliceSchema))
    .mutation(async ({ ctx, input }) => {
      const { requirementId, ...data } = input;
      return requirementService.createExecutionSlice(ctx.db, requirementId, data, ctx.actor);
    }),

  updateSlice: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateExecutionSliceSchema }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.updateExecutionSlice(ctx.db, input.id, input.data, ctx.actor);
    }),

  deleteSlice: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.deleteExecutionSlice(ctx.db, input.id, ctx.actor);
    }),
});
