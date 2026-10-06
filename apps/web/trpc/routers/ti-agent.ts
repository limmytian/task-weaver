import { z } from "zod";
import {
  acquireTiAgentRunSchema,
  completeTiAgentRunSchema,
  createTiAgentRunSchema,
  listTiAgentRunsSchema,
  listTiModelConfigsSchema,
  createResourceServices,
  resolveTiModelSchema,
  setDefaultTiModelSchema,
  upsertTiAgentPolicySchema,
  upsertTiModelConfigSchema,
} from "@task-weaver/core";
import { router, resourceProcedure, ordinaryResourceProcedure } from "../init";

export const tiAgentRouter = router({
  listConfigs: ordinaryResourceProcedure
    .input(listTiModelConfigsSchema)
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.listModelConfigs(ctx.db, input, ctx.actor)),

  upsertConfig: ordinaryResourceProcedure
    .input(upsertTiModelConfigSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.upsertModelConfig(ctx.db, input, ctx.actor)),

  setDefaultConfig: ordinaryResourceProcedure
    .input(setDefaultTiModelSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.setDefaultModel(ctx.db, input, ctx.actor)),

  resolveModel: ordinaryResourceProcedure
    .input(resolveTiModelSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.resolveModel(ctx.db, input, ctx.actor)),

  getPolicy: ordinaryResourceProcedure
    .input(z.object({
      ownerId: z.string().optional(),
      ownerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.getPolicy(ctx.db, input ?? {}, ctx.actor)),

  upsertPolicy: ordinaryResourceProcedure
    .input(upsertTiAgentPolicySchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.upsertPolicy(ctx.db, input, ctx.actor)),

  listRuns: ordinaryResourceProcedure
    .input(listTiAgentRunsSchema)
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.listRuns(ctx.db, input)),

  getRun: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.getRun(ctx.db, input.id)),

  createRun: resourceProcedure
    .input(createTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.createRun(ctx.db, input, ctx.actor)),

  acquireRun: resourceProcedure
    .input(acquireTiAgentRunSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.acquireRun(ctx.db, input, ctx.actor)),

  completeRun: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: completeTiAgentRunSchema }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).tiAgentService.completeRun(ctx.db, input.id, input.data, ctx.actor)),
});
