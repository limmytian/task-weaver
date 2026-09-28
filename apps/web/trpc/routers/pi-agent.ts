import { z } from "zod";
import {
  acquirePiAgentRunSchema,
  completePiAgentRunSchema,
  createPiAgentRunSchema,
  listPiAgentRunsSchema,
  listPiModelConfigsSchema,
  piAgentService,
  resolvePiModelSchema,
  setDefaultPiModelSchema,
  upsertPiAgentPolicySchema,
  upsertPiModelConfigSchema,
} from "@task-weaver/core";
import { router, publicProcedure } from "../init";

export const piAgentRouter = router({
  listConfigs: publicProcedure
    .input(listPiModelConfigsSchema)
    .query(async ({ ctx, input }) => piAgentService.listModelConfigs(ctx.db, input, ctx.actor)),

  upsertConfig: publicProcedure
    .input(upsertPiModelConfigSchema)
    .mutation(async ({ ctx, input }) => piAgentService.upsertModelConfig(ctx.db, input, ctx.actor)),

  setDefaultConfig: publicProcedure
    .input(setDefaultPiModelSchema)
    .mutation(async ({ ctx, input }) => piAgentService.setDefaultModel(ctx.db, input, ctx.actor)),

  resolveModel: publicProcedure
    .input(resolvePiModelSchema)
    .mutation(async ({ ctx, input }) => piAgentService.resolveModel(ctx.db, input, ctx.actor)),

  getPolicy: publicProcedure
    .input(z.object({
      ownerId: z.string().optional(),
      ownerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => piAgentService.getPolicy(ctx.db, input ?? {}, ctx.actor)),

  upsertPolicy: publicProcedure
    .input(upsertPiAgentPolicySchema)
    .mutation(async ({ ctx, input }) => piAgentService.upsertPolicy(ctx.db, input, ctx.actor)),

  listRuns: publicProcedure
    .input(listPiAgentRunsSchema)
    .query(async ({ ctx, input }) => piAgentService.listRuns(ctx.db, input)),

  getRun: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => piAgentService.getRun(ctx.db, input.id)),

  createRun: publicProcedure
    .input(createPiAgentRunSchema)
    .mutation(async ({ ctx, input }) => piAgentService.createRun(ctx.db, input, ctx.actor)),

  acquireRun: publicProcedure
    .input(acquirePiAgentRunSchema)
    .mutation(async ({ ctx, input }) => piAgentService.acquireRun(ctx.db, input, ctx.actor)),

  completeRun: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: completePiAgentRunSchema }))
    .mutation(async ({ ctx, input }) => piAgentService.completeRun(ctx.db, input.id, input.data, ctx.actor)),
});
