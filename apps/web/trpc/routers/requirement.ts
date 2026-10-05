import { z } from "zod";
import { router, resourceProcedure } from "../init";
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
  list: resourceProcedure
    .input(listRequirementsSchema)
    .query(async ({ ctx, input }) => {
      return requirementService.listRequirements(ctx.db, input);
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.getRequirement(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(createRequirementSchema)
    .mutation(async ({ ctx, input }) => {
      return requirementService.createRequirement(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateRequirementSchema }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.updateRequirement(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.deleteRequirement(ctx.db, input.id, ctx.actor);
    }),

  unlinkDocument: resourceProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.unlinkDocumentFromRequirement(ctx.db, input.linkId);
    }),

  linkDocument: resourceProcedure
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

  listDependencies: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.listRequirementDependencies(ctx.db, input.requirementId);
    }),

  addDependency: resourceProcedure
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

  removeDependency: resourceProcedure
    .input(z.object({ depId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.removeRequirementDependency(ctx.db, input.depId, ctx.actor);
    }),

  burndown: resourceProcedure
    .input(z.object({ id: z.string().uuid(), days: z.number().int().min(1).max(365).optional() }))
    .query(async ({ ctx, input }) => {
      return requirementService.getRequirementBurndown(ctx.db, input.id);
    }),

  listSlices: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.listExecutionSlices(ctx.db, input.requirementId);
    }),

  createSlice: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }).merge(createExecutionSliceSchema))
    .mutation(async ({ ctx, input }) => {
      const { requirementId, ...data } = input;
      return requirementService.createExecutionSlice(ctx.db, requirementId, data, ctx.actor);
    }),

  updateSlice: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateExecutionSliceSchema }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.updateExecutionSlice(ctx.db, input.id, input.data, ctx.actor);
    }),

  deleteSlice: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return requirementService.deleteExecutionSlice(ctx.db, input.id, ctx.actor);
    }),
});
