import { z } from "zod";
import { createPlanDraftSchema, updatePlanDraftSchema, createResourceServices, ValidationError } from "@task-weaver/core";
import { router, ordinaryResourceProcedure as procedure } from "../init";

const key = z.object({ projectId: z.string().uuid(), draftId: z.string().uuid() });
export const planRouter = router({
  createDraft: procedure.input(createPlanDraftSchema.omit({ source: true })).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.createPlanDraft(ctx.db, { ...input, source: "web" }, ctx.actor)),
  capabilities: procedure.input(z.object({ projectId: z.string().uuid() })).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.planDraftCapabilities(ctx.db, input.projectId)),
  listDrafts: procedure.input(z.object({ projectId: z.string().uuid() })).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.listPlanDrafts(ctx.db, input.projectId)),
  getDraft: procedure.input(key).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.getPlanDraft(ctx.db, input.projectId, input.draftId)),
  getReceipt: procedure.input(key).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.getPlanDraftReceipt(ctx.db, input.projectId, input.draftId)),
  updateDraft: procedure.input(z.object({ draftId: z.string().uuid(), data: updatePlanDraftSchema })).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.updatePlanDraft(ctx.db, input.draftId, input.data, ctx.actor)),
  discardDraft: procedure.input(key.extend({ revision: z.number().int().positive() })).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.discardPlanDraft(ctx.db, input.projectId, input.draftId, input.revision, ctx.actor)),
  applyDraft: procedure.input(key.extend({ revision: z.number().int().positive(), operationKey: z.string().uuid() })).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).planService.applyPlanDraft(ctx.db, input.projectId, input.draftId, input.revision, input.operationKey, ctx.actor)),
  validateDraft: procedure.input(key).mutation(async ({ ctx, input }) => {
    try {
      const value = await createResourceServices(ctx.identity).planService.validatePlanDraft(ctx.db, input.projectId, input.draftId, ctx.actor);
      return { ok: true as const, ...value };
    } catch (error) {
      if (error instanceof ValidationError) {
        const safe = /^(Plan (?:task|requirement) dependencies contain a cycle|Duplicate (?:task|requirement|document|slice) key|Unknown (?:task|requirement|document|slice) reference|Slice |Task .* assigned to multiple slices|A referenced requirement or task is cancelled or archived)/.test(error.message);
        return { ok: false as const, diagnostic: safe ? error.message : "Plan validation failed. Check references, permissions and assignments." };
      }
      throw error;
    }
  }),
});
