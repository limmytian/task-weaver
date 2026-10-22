import { z } from "zod";
import { router, ordinaryResourceProcedure as procedure } from "../init";
import { createInboundSourceService, createInboundSourceSchema, updateInboundSourceSchema, listInboundEventsSchema } from "@task-weaver/core";
const id = z.object({ id: z.string().uuid() });
const event = id.extend({ eventId: z.string().uuid() });
export const inboundRouter = router({
  list: procedure.input(z.object({ projectId: z.string().uuid() })).query(({ ctx, input }) => createInboundSourceService(ctx.identity).list(ctx.db, input.projectId)),
  create: procedure.input(createInboundSourceSchema).mutation(({ ctx, input }) => createInboundSourceService(ctx.identity).create(ctx.db, input)),
  update: procedure.input(id.extend({ data: updateInboundSourceSchema })).mutation(({ ctx, input }) => createInboundSourceService(ctx.identity).update(ctx.db, input.id, input.data)),
  delete: procedure.input(id).mutation(({ ctx, input }) => createInboundSourceService(ctx.identity).delete(ctx.db, input.id)),
  history: procedure.input(id.extend({ filters: listInboundEventsSchema.optional() })).query(({ ctx, input }) => createInboundSourceService(ctx.identity).history(ctx.db, input.id, input.filters)),
  actions: procedure.input(event).query(({ ctx, input }) => createInboundSourceService(ctx.identity).receipts(ctx.db, input.id, input.eventId)),
  retry: procedure.input(event).mutation(({ ctx, input }) => createInboundSourceService(ctx.identity).retry(ctx.db, input.id, input.eventId)),
});
