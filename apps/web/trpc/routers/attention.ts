import { z } from "zod";
import { resolveEventCursorIncident, attentionQuerySchema, createAttentionService } from "@task-weaver/core";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";

export const attentionRouter = router({
  incidents: resourceProcedure.input(z.object({ projectId: z.string().uuid().optional() })).query(({ ctx, input }) => createAttentionService(ctx.identity).incidents(ctx.db, input.projectId)),
  resolveIncident: resourceProcedure.input(z.object({ projectId: z.string().uuid(), incidentId: z.string().uuid() })).mutation(({ ctx, input }) => resolveEventCursorIncident(ctx.db, input, ctx.identity)),
  list: resourceProcedure.input(attentionQuerySchema).query(({ ctx, input }) =>
    createAttentionService(ctx.identity).list(ctx.db, input)),
});
