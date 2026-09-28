import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  memoryService,
  recordMemorySchema,
  updateMemorySchema,
  listMemoriesSchema,
  searchMemorySchema,
} from "@task-weaver/core";

export const memoryRouter = router({
  list: publicProcedure
    .input(listMemoriesSchema.default({}))
    .query(async ({ ctx, input }) => {
      return memoryService.listMemories(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input.personalOwnerType ?? ctx.actor.type,
      });
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return memoryService.getMemory(ctx.db, input.id);
    }),

  create: publicProcedure
    .input(recordMemorySchema)
    .mutation(async ({ ctx, input }) => {
      return memoryService.recordMemory(ctx.db, input, ctx.actor);
    }),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateMemorySchema }))
    .mutation(async ({ ctx, input }) => {
      return memoryService.updateMemory(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return memoryService.forgetMemory(ctx.db, input.id, ctx.actor);
    }),

  search: publicProcedure
    .input(searchMemorySchema)
    .query(async ({ ctx, input }) => {
      return memoryService.searchMemories(ctx.db, {
        ...input,
        preferredActorId: input.preferredActorId ?? ctx.actor.id,
        personalOwnerId: input.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input.personalOwnerType ?? ctx.actor.type,
      });
    }),
});
