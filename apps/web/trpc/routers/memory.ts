import { z } from "zod";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";
import {
  createResourceServices,
  recordMemorySchema,
  updateMemorySchema,
  listMemoriesSchema,
  searchMemorySchema,
} from "@task-weaver/core";

export const memoryRouter = router({
  list: resourceProcedure
    .input(listMemoriesSchema.default({}))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.listMemories(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerType: input.personalOwnerType ?? "human",
      });
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.getMemory(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(recordMemorySchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.recordMemory(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateMemorySchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.updateMemory(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.forgetMemory(ctx.db, input.id, ctx.actor);
    }),

  search: resourceProcedure
    .input(searchMemorySchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).memoryService.searchMemories(ctx.db, {
        ...input,
        preferredActorId: input.preferredActorId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerId: input.personalOwnerId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerType: input.personalOwnerType ?? "human",
      });
    }),
});
