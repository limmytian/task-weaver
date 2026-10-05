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
import { router, resourceProcedure } from "../init";

export const tiAgentRouter = router({
  listConfigs: resourceProcedure
    .input(listTiModelConfigsSchema)
    .query(async ({ ctx, input }) => tiAgentService.listModelConfigs(ctx.db, input, ctx.actor)),

  upsertConfig: resourceProcedure
    .input(upsertTiModelConfigSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.upsertModelConfig(ctx.db, input, ctx.actor)),

  setDefaultConfig: resourceProcedure
    .input(setDefaultTiModelSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.setDefaultModel(ctx.db, input, ctx.actor)),

  resolveModel: resourceProcedure
    .input(resolveTiModelSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.resolveModel(ctx.db, input, ctx.actor)),

  getPolicy: resourceProcedure
    .input(z.object({
      ownerId: z.string().optional(),
      ownerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => tiAgentService.getPolicy(ctx.db, input ?? {}, ctx.actor)),

  upsertPolicy: resourceProcedure
    .input(upsertTiAgentPolicySchema)
    .mutation(async ({ ctx, input }) => tiAgentService.upsertPolicy(ctx.db, input, ctx.actor)),

  listRuns: resourceProcedure
    .input(listTiAgentRunsSchema)
    .query(async ({ ctx, input }) => tiAgentService.listRuns(ctx.db, input)),

  getRun: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => tiAgentService.getRun(ctx.db, input.id)),

  createRun: resourceProcedure
    .input(createTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.createRun(ctx.db, input, ctx.actor)),

  acquireRun: resourceProcedure
    .input(acquireTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => tiAgentService.acquireRun(ctx.db, input, ctx.actor)),

  completeRun: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: completeTiAgentRunSchema }))
    .mutation(async ({ ctx, input }) => tiAgentService.completeRun(ctx.db, input.id, input.data, ctx.actor)),
});
