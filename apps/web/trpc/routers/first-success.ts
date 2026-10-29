import { createFirstSuccessService, firstSuccessQuerySchema } from "@task-weaver/core";
import { router, ordinaryResourceProcedure as procedure } from "../init";

export const firstSuccessRouter = router({
  state: procedure.input(firstSuccessQuerySchema).query(({ ctx, input }) => createFirstSuccessService(ctx.identity).get(ctx.db, input)),
});
