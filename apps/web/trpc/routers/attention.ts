import { attentionQuerySchema, createAttentionService } from "@task-weaver/core";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";

export const attentionRouter = router({
  list: resourceProcedure.input(attentionQuerySchema).query(({ ctx, input }) =>
    createAttentionService(ctx.identity).list(ctx.db, input)),
});
