import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  documentService,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
  searchDocumentsSchema,
} from "@task-weaver/core";

export const documentRouter = router({
  list: publicProcedure
    .input(listDocumentsSchema)
    .query(async ({ ctx, input }) => {
      return documentService.listDocuments(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input.personalOwnerType ?? ctx.actor.type,
      });
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return documentService.getDocumentDetail(ctx.db, input.id);
    }),

  create: publicProcedure
    .input(createDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      return documentService.createDocument(ctx.db, input, ctx.actor);
    }),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateDocumentSchema }))
    .mutation(async ({ ctx, input }) => {
      return documentService.updateDocument(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return documentService.deleteDocument(ctx.db, input.id, ctx.actor);
    }),

  unlinkDocuments: publicProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return documentService.unlinkDocuments(ctx.db, input.linkId);
    }),

  unlinkFromTask: publicProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return documentService.unlinkDocumentFromTask(ctx.db, input.linkId);
    }),

  search: publicProcedure
    .input(searchDocumentsSchema)
    .query(async ({ ctx, input }) => {
      return documentService.searchDocuments(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input.personalOwnerType ?? ctx.actor.type,
      });
    }),

  resolveWikiLinks: publicProcedure
    .input(z.object({ titles: z.array(z.string().min(1)).min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      return documentService.resolveDocumentTitles(ctx.db, input.titles);
    }),

  linkToTask: publicProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        taskId: z.string().uuid(),
        linkType: z.enum(["references", "documents", "output"]).default("references"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return documentService.linkDocumentToTask(
        ctx.db,
        input.documentId,
        input.taskId,
        input.linkType,
        ctx.actor,
      );
    }),

  linkToRequirement: publicProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        requirementId: z.string().uuid(),
        linkType: z.enum(["references", "documents", "output"]).default("references"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { requirementService } = await import("@task-weaver/core");
      return requirementService.linkDocumentToRequirement(
        ctx.db,
        input.requirementId,
        input.documentId,
        input.linkType,
        ctx.actor,
      );
    }),

  versions: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return documentService.listDocumentVersions(ctx.db, { documentId: input.id, limit: 50, offset: 0 });
    }),

  version: publicProcedure
    .input(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }))
    .query(async ({ ctx, input }) => {
      return documentService.getDocumentVersion(ctx.db, input.id, input.version);
    }),

  compareVersions: publicProcedure
    .input(z.object({ id: z.string().uuid(), from: z.number().int().min(1), to: z.number().int().min(1) }))
    .query(async ({ ctx, input }) => {
      return documentService.compareDocumentVersions(ctx.db, { documentId: input.id, from: input.from, to: input.to });
    }),

  revertVersion: publicProcedure
    .input(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return documentService.revertDocument(ctx.db, input.id, { version: input.version }, ctx.actor);
    }),
});
