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
import { router, publicProcedure } from "../init";

export const assistantRouter = router({
  listConversations: publicProcedure
    .input(listAssistantConversationsSchema)
    .query(async ({ ctx, input }) => assistantService.listConversations(ctx.db, input, ctx.actor)),

  getConversation: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => assistantService.getConversation(ctx.db, input.id, ctx.actor)),

  renameConversation: publicProcedure
    .input(renameAssistantConversationSchema)
    .mutation(async ({ ctx, input }) => assistantService.renameConversation(ctx.db, input, ctx.actor)),

  deleteConversation: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => assistantService.deleteConversation(ctx.db, input.id, ctx.actor)),

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
