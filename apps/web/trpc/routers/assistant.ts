import {
  assistantService,
  buildAssistantContextSchema,
  executeAssistantActionSchema,
  sendAssistantMessageSchema,
  updateAssistantActionStatusSchema,
} from "@task-weaver/core";
import { router, publicProcedure } from "../init";

export const assistantRouter = router({
  buildContext: publicProcedure
    .input(buildAssistantContextSchema)
    .query(async ({ ctx, input }) => assistantService.buildAssistantContext(ctx.db, input, ctx.actor)),

  sendMessage: publicProcedure
    .input(sendAssistantMessageSchema)
    .mutation(async ({ ctx, input }) => assistantService.sendReadOnlyMessage(ctx.db, input, ctx.actor)),

  executeAction: publicProcedure
    .input(executeAssistantActionSchema)
    .mutation(async ({ ctx, input }) => assistantService.executeApprovedAction(ctx.db, input.id, ctx.actor)),

  updateActionStatus: publicProcedure
    .input(executeAssistantActionSchema.extend({ data: updateAssistantActionStatusSchema }))
    .mutation(async ({ ctx, input }) => assistantService.updateActionStatus(ctx.db, input.id, input.data, ctx.actor)),
});
