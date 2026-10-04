import { z } from "zod";
import {
  acquireTiAgentRunSchema,
  completeTiAgentRunSchema,
  createTiAgentRunSchema,
  listTiAgentRunsSchema,
  listTiModelConfigsSchema,
  tiAgentService,
  resolveTiModelSchema,
  setDefaultTiModelSchema,
  upsertTiAgentPolicySchema,
  upsertTiModelConfigSchema,
} from "@task-weaver/core";
import { router, publicProcedure } from "../init";

export const tiAgentRouter = router({
  listConfigs: publicProcedure
    .input(listTiModelConfigsSchema)
    .query(async ({ ctx, input }) => tiAgentService.listModelConfigs(ctx.db, input, ctx.actor)),

  upsertConfig: publicProcedure
    .input(upsertTiModelConfigSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.upsertModelConfig(ctx.db, input, ctx.actor)),

  setDefaultConfig: publicProcedure
    .input(setDefaultTiModelSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.setDefaultModel(ctx.db, input, ctx.actor)),

  resolveModel: publicProcedure
    .input(resolveTiModelSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.resolveModel(ctx.db, input, ctx.actor)),

  getPolicy: publicProcedure
    .input(z.object({
      ownerId: z.string().optional(),
      ownerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => tiAgentService.getPolicy(ctx.db, input ?? {}, ctx.actor)),

  upsertPolicy: publicProcedure
    .input(upsertTiAgentPolicySchema)
    .mutation(async ({ ctx, input }) => tiAgentService.upsertPolicy(ctx.db, input, ctx.actor)),

  listRuns: publicProcedure
    .input(listTiAgentRunsSchema)
    .query(async ({ ctx, input }) => tiAgentService.listRuns(ctx.db, input)),

  getRun: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => tiAgentService.getRun(ctx.db, input.id)),

  createRun: publicProcedure
    .input(createTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.createRun(ctx.db, input, ctx.actor)),

  acquireRun: publicProcedure
    .input(acquireTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.acquireRun(ctx.db, input, ctx.actor)),

  completeRun: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: completeTiAgentRunSchema }))
    .mutation(async ({ ctx, input }) => tiAgentService.completeRun(ctx.db, input.id, input.data, ctx.actor)),
});
