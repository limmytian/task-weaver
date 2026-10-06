import { z } from "zod";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";
import {
  createResourceServices,
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
      return createResourceServices(ctx.identity).requirementService.listRequirements(ctx.db, input);
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.getRequirement(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(createRequirementSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.createRequirement(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateRequirementSchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.updateRequirement(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.deleteRequirement(ctx.db, input.id, ctx.actor);
    }),

  unlinkDocument: resourceProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.unlinkDocumentFromRequirement(ctx.db, input.linkId);
    }),

  linkDocument: resourceProcedure
    .input(
      z.object({ requirementId: z.string().uuid() }).merge(linkDocumentToRequirementSchema),
    )
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.linkDocumentToRequirement(
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
      return createResourceServices(ctx.identity).requirementService.listRequirementDependencies(ctx.db, input.requirementId);
    }),

  addDependency: resourceProcedure
    .input(
      z.object({ requirementId: z.string().uuid() }).merge(createRequirementDependencySchema),
    )
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.addRequirementDependency(
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
      return createResourceServices(ctx.identity).requirementService.removeRequirementDependency(ctx.db, input.depId, ctx.actor);
    }),

  burndown: resourceProcedure
    .input(z.object({ id: z.string().uuid(), days: z.number().int().min(1).max(365).optional() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.getRequirementBurndown(ctx.db, input.id);
    }),

  listSlices: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.listExecutionSlices(ctx.db, input.requirementId);
    }),

  createSlice: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }).merge(createExecutionSliceSchema))
    .mutation(async ({ ctx, input }) => {
      const { requirementId, ...data } = input;
      return createResourceServices(ctx.identity).requirementService.createExecutionSlice(ctx.db, requirementId, data, ctx.actor);
    }),

  updateSlice: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateExecutionSliceSchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.updateExecutionSlice(ctx.db, input.id, input.data, ctx.actor);
    }),

  deleteSlice: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.deleteExecutionSlice(ctx.db, input.id, ctx.actor);
    }),
});
