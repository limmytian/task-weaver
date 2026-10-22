import { z } from "zod";
import { router, ordinaryResourceProcedure as procedure } from "../init";
import { createWebhookService, createWebhookSchema, updateWebhookSchema, listWebhooksSchema, listWebhookDeliveriesSchema } from "@task-weaver/core";
const id = z.object({ id: z.string().uuid() });
const delivery = id.extend({ deliveryId: z.string().uuid() });
export const webhookRouter = router({
  list: procedure.input(listWebhooksSchema.default({})).query(({ ctx, input }) => createWebhookService(ctx.identity).listWebhooks(ctx.db, input)),
  create: procedure.input(createWebhookSchema).mutation(({ ctx, input }) => createWebhookService(ctx.identity).createWebhook(ctx.db, input)),
  update: procedure.input(id.extend({ data: updateWebhookSchema })).mutation(({ ctx, input }) => createWebhookService(ctx.identity).updateWebhook(ctx.db, input.id, input.data)),
  delete: procedure.input(id).mutation(({ ctx, input }) => createWebhookService(ctx.identity).deleteWebhook(ctx.db, input.id)),
  test: procedure.input(id).mutation(({ ctx, input }) => createWebhookService(ctx.identity).sendTestEvent(ctx.db, input.id)),
  deliveries: procedure.input(id.extend({ filters: listWebhookDeliveriesSchema.optional() })).query(({ ctx, input }) => createWebhookService(ctx.identity).listWebhookDeliveries(ctx.db, input.id, input.filters)),
  attempts: procedure.input(delivery).query(({ ctx, input }) => createWebhookService(ctx.identity).getWebhookDeliveryAttempts(ctx.db, input.id, input.deliveryId)),
  replay: procedure.input(delivery).mutation(({ ctx, input }) => createWebhookService(ctx.identity).retryWebhookDelivery(ctx.db, input.id, input.deliveryId)),
});
