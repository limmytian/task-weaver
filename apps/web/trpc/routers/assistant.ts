import { z } from "zod";
import {
  assistantService,
  buildAssistantContextSchema,
  executeAssistantActionSchema,
  listAssistantConversationsSchema,
  renameAssistantConversationSchema,
  sendAssistantMessageSchema,
  updateAssistantActionStatusSchema,
} from "@task-weaver/core";
import { router, resourceProcedure } from "../init";

export const assistantRouter = router({
  listConversations: resourceProcedure
    .input(listAssistantConversationsSchema)
    .query(async ({ ctx, input }) => assistantService.listConversations(ctx.db, input, ctx.actor)),

  getConversation: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => assistantService.getConversation(ctx.db, input.id, ctx.actor)),

  renameConversation: resourceProcedure
    .input(renameAssistantConversationSchema)
    .mutation(async ({ ctx, input }) => assistantService.renameConversation(ctx.db, input, ctx.actor)),

  deleteConversation: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => assistantService.deleteConversation(ctx.db, input.id, ctx.actor)),

  buildContext: resourceProcedure
    .input(buildAssistantContextSchema)
    .query(async ({ ctx, input }) => assistantService.buildAssistantContext(ctx.db, input, ctx.actor)),

  sendMessage: resourceProcedure
    .input(sendAssistantMessageSchema)
    .mutation(async ({ ctx, input }) => assistantService.sendReadOnlyMessage(ctx.db, input, ctx.actor)),

  executeAction: resourceProcedure
    .input(executeAssistantActionSchema)
    .mutation(async ({ ctx, input }) => assistantService.executeApprovedAction(ctx.db, input.id, ctx.actor)),

  updateActionStatus: resourceProcedure
    .input(executeAssistantActionSchema.extend({ data: updateAssistantActionStatusSchema }))
    .mutation(async ({ ctx, input }) => assistantService.updateActionStatus(ctx.db, input.id, input.data, ctx.actor)),
});
