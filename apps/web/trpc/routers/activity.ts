import { router, ordinaryResourceProcedure } from "../init";
import { createResourceServices, activityQuerySchema } from "@task-weaver/core";

export const activityRouter = router({
  list: ordinaryResourceProcedure.input(activityQuerySchema).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).activityLogService.listActivityLog(ctx.db, input),
  ),
});
