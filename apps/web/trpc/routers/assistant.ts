import { z } from "zod";
import {
  createAssistantService, createChatModelService, saveChatModelSchema, chatModelIdSchema,
  updateAssistantPolicySchema,
  buildAssistantContextSchema,
  executeAssistantActionSchema,
  listAssistantConversationsSchema,
  renameAssistantConversationSchema,
  sendAssistantMessageSchema,
  updateAssistantActionStatusSchema,
} from "@task-weaver/core";
import { router, ordinaryResourceProcedure } from "../init";

export const assistantRouter = router({
  listModels: ordinaryResourceProcedure.query(({ ctx }) => createChatModelService(ctx.identity).list(ctx.db)),
  saveModel: ordinaryResourceProcedure.input(saveChatModelSchema).mutation(({ ctx, input }) => createChatModelService(ctx.identity).save(ctx.db, input)),
  deleteModelKey: ordinaryResourceProcedure.input(chatModelIdSchema).mutation(({ ctx, input }) => createChatModelService(ctx.identity).deleteKey(ctx.db, input.id)),
  testModel: ordinaryResourceProcedure.input(chatModelIdSchema).mutation(({ ctx, input }) => createChatModelService(ctx.identity).test(ctx.db, input.id)),
  getPolicy: ordinaryResourceProcedure.query(({ ctx }) => createAssistantService(ctx.identity).getPolicy(ctx.db)),
  updatePolicy: ordinaryResourceProcedure.input(updateAssistantPolicySchema).mutation(({ ctx, input }) => createAssistantService(ctx.identity).updatePolicy(ctx.db, input)),
  listConversations: ordinaryResourceProcedure
    .input(listAssistantConversationsSchema)
    .query(async ({ ctx, input }) => createAssistantService(ctx.identity).listConversations(ctx.db, input)),

  getConversation: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createAssistantService(ctx.identity).getConversation(ctx.db, input.id)),

  renameConversation: ordinaryResourceProcedure
    .input(renameAssistantConversationSchema)
    .mutation(async ({ ctx, input }) => createAssistantService(ctx.identity).renameConversation(ctx.db, input)),

  deleteConversation: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createAssistantService(ctx.identity).deleteConversation(ctx.db, input.id)),

  buildContext: ordinaryResourceProcedure
    .input(buildAssistantContextSchema)
    .query(async ({ ctx, input }) => createAssistantService(ctx.identity).buildAssistantContext(ctx.db, input)),

  sendMessage: ordinaryResourceProcedure
    .input(sendAssistantMessageSchema)
    .mutation(async ({ ctx, input }) => createAssistantService(ctx.identity).sendReadOnlyMessage(ctx.db, input)),

  executeAction: ordinaryResourceProcedure
    .input(executeAssistantActionSchema)
    .mutation(async ({ ctx, input }) => createAssistantService(ctx.identity).executeApprovedAction(ctx.db, input.id)),

  updateActionStatus: ordinaryResourceProcedure
    .input(executeAssistantActionSchema.extend({ data: updateAssistantActionStatusSchema }))
    .mutation(async ({ ctx, input }) => createAssistantService(ctx.identity).updateActionStatus(ctx.db, input.id, input.data)),
});
