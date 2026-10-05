import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  memoryService,
  recordMemorySchema,
  updateMemorySchema,
  listMemoriesSchema,
  searchMemorySchema,
} from "@task-weaver/core";

export const memoryRouter = router({
  list: resourceProcedure
    .input(listMemoriesSchema.default({}))
    .query(async ({ ctx, input }) => {
      return memoryService.listMemories(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input.personalOwnerType ?? ctx.actor.type,
      });
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return memoryService.getMemory(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(recordMemorySchema)
    .mutation(async ({ ctx, input }) => {
      return memoryService.recordMemory(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateMemorySchema }))
    .mutation(async ({ ctx, input }) => {
      return memoryService.updateMemory(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return memoryService.forgetMemory(ctx.db, input.id, ctx.actor);
    }),

  search: resourceProcedure
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
