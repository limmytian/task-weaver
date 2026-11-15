import { router, ordinaryResourceProcedure } from "../init";
import { createThinWorkerService } from "@task-weaver/core";
import { z } from "zod";
import { workerResolveSchema, workerGitReconcileSchema } from "@task-weaver/contracts";

export const workerRouter = router({
  thinWorkers: ordinaryResourceProcedure.input(z.object({ projectId: z.string().uuid() }))
    .query(({ ctx, input }) => createThinWorkerService(ctx.identity).listWorkers(ctx.db, input.projectId)),
  thinAttempts: ordinaryResourceProcedure.input(z.object({ projectId: z.string().uuid(), requirementId: z.string().uuid().optional() }))
    .query(({ ctx, input }) => createThinWorkerService(ctx.identity).list(ctx.db, input.projectId, input.requirementId)),
  resolveAttempt: ordinaryResourceProcedure.input(workerResolveSchema)
    .mutation(({ ctx, input }) => createThinWorkerService(ctx.identity).resolve(ctx.db, input)),
  gitDeliveries: ordinaryResourceProcedure.input(z.object({ projectId: z.string().uuid(), attemptId: z.string().uuid() }))
    .query(({ ctx, input }) => createThinWorkerService(ctx.identity).listGitDeliveries(ctx.db, input.projectId, input.attemptId)),
  reconcileGitDelivery: ordinaryResourceProcedure.input(workerGitReconcileSchema)
    .mutation(({ ctx, input }) => createThinWorkerService(ctx.identity).reconcileGitDelivery(ctx.db, input)),
});
