import { z } from "zod";
import { router, publicProcedure } from "../init";
import { apiKeyService } from "@task-weaver/core";

export const apiKeyRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return apiKeyService.listApiKeys(ctx.db);
  }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        permissions: z.record(z.boolean()).optional(),
        expiresAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return apiKeyService.createApiKey(ctx.db, input);
    }),

  revoke: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return apiKeyService.revokeApiKey(ctx.db, input.id);
    }),
});
