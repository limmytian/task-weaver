import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  documentService,
  repositoryService,
  taskService,
  requirementService,
} from "@task-weaver/core";

const searchInputSchema = z.object({
  query: z.string().min(1),
  projectId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  mode: z.enum(["keyword", "fulltext", "semantic", "hybrid"]).default("keyword"),
});

type DocumentSearchItem = {
  id: string;
  title: string;
  summary: string | null;
  keywords: string[] | null;
  docType: string | null;
  projectId: string | null;
  personalOwnerId: string | null;
  personalOwnerType: "human" | "agent" | null;
  tags: string[] | null;
  updatedAt: Date;
  score?: number;
  scores?: { lexical?: number; semantic?: number };
};

export const searchRouter = router({
  all: publicProcedure
    .input(searchInputSchema)
    .query(async ({ ctx, input }) => {
      const [matchedTasks, matchedDocs, matchedRequirements, matchedRepositories] =
        await Promise.all([
          taskService.searchTasks(ctx.db, {
            query: input.query,
            projectId: input.projectId,
            scope: input.projectId ? "project" : "personal",
            personalOwnerId: ctx.actor.id,
            personalOwnerType: ctx.actor.type,
            limit: input.limit,
          }),
          documentService.searchDocumentsWithMetadata(ctx.db, {
            query: input.query,
            mode: input.mode,
            projectId: input.projectId,
            includeGlobal: true,
            includePersonal: !input.projectId,
            personalOwnerId: ctx.actor.id,
            personalOwnerType: ctx.actor.type,
            limit: input.limit,
            keywordWeight: 0.3,
            fulltextWeight: 0.7,
          }),
          requirementService.searchRequirements(ctx.db, {
            query: input.query,
            projectId: input.projectId,
            limit: input.limit,
          }),
          repositoryService.listRepositories(ctx.db, {
            query: input.query,
            status: "active",
            sort: "relevance",
            page: 1,
            pageSize: input.limit,
          }, ctx.actor),
        ]);

      return {
        tasks: matchedTasks,
        documents: matchedDocs.items as DocumentSearchItem[],
        documentMetadata: matchedDocs.metadata,
        requirements: matchedRequirements,
        repositories: matchedRepositories.items,
      };
    }),
});
