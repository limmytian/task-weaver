import { z } from "zod";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";
import {
  createResourceServices,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
  searchDocumentsSchema,
} from "@task-weaver/core";

export const documentRouter = router({
  list: resourceProcedure
    .input(listDocumentsSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.listDocuments(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerType: input.personalOwnerType ?? "human",
      });
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.getDocumentDetail(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(createDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.createDocument(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateDocumentSchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.updateDocument(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.deleteDocument(ctx.db, input.id, ctx.actor);
    }),

  unlinkDocuments: resourceProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.unlinkDocuments(ctx.db, input.linkId);
    }),

  unlinkFromTask: resourceProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.unlinkDocumentFromTask(ctx.db, input.linkId);
    }),

  search: resourceProcedure
    .input(searchDocumentsSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.searchDocuments(ctx.db, {
        ...input,
        personalOwnerId: input.personalOwnerId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerType: input.personalOwnerType ?? "human",
      });
    }),

  resolveWikiLinks: resourceProcedure
    .input(z.object({ titles: z.array(z.string().min(1)).min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.resolveDocumentTitles(ctx.db, input.titles);
    }),

  linkToTask: resourceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        taskId: z.string().uuid(),
        linkType: z.enum(["references", "documents", "output"]).default("references"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.linkDocumentToTask(
        ctx.db,
        input.documentId,
        input.taskId,
        input.linkType,
        ctx.actor,
      );
    }),

  linkToRequirement: resourceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        requirementId: z.string().uuid(),
        linkType: z.enum(["references", "documents", "output"]).default("references"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).requirementService.linkDocumentToRequirement(
        ctx.db,
        input.requirementId,
        input.documentId,
        input.linkType,
        ctx.actor,
      );
    }),

  versions: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.listDocumentVersions(ctx.db, { documentId: input.id, limit: 50, offset: 0 });
    }),

  version: resourceProcedure
    .input(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.getDocumentVersion(ctx.db, input.id, input.version);
    }),

  compareVersions: resourceProcedure
    .input(z.object({ id: z.string().uuid(), from: z.number().int().min(1), to: z.number().int().min(1) }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.compareDocumentVersions(ctx.db, { documentId: input.id, from: input.from, to: input.to });
    }),

  revertVersion: resourceProcedure
    .input(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).documentService.revertDocument(ctx.db, input.id, { version: input.version }, ctx.actor);
    }),
});
