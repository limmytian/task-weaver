import { router, ordinaryResourceProcedure } from "../init";
import { createThinWorkerService } from "@task-weaver/core";
import { z } from "zod";

export const workerRouter = router({
  thinWorkers: ordinaryResourceProcedure.input(z.object({ projectId: z.string().uuid() }))
    .query(({ ctx, input }) => createThinWorkerService(ctx.identity).listWorkers(ctx.db, input.projectId)),
  thinAttempts: ordinaryResourceProcedure.input(z.object({ projectId: z.string().uuid() }))
    .query(({ ctx, input }) => createThinWorkerService(ctx.identity).list(ctx.db, input.projectId)),
});
