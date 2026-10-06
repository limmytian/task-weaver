import { z } from "zod";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";
import { createResourceServices, personalResourceOwnerId, type repositoryService } from "@task-weaver/core";

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
  all: resourceProcedure
    .input(searchInputSchema)
    .query(async ({ ctx, input }) => {
      const [matchedTasks, matchedDocs, matchedRequirements, matchedRepositories] =
        await Promise.all([
          createResourceServices(ctx.identity).taskService.searchTasks(ctx.db, {
            query: input.query,
            projectId: input.projectId,
            scope: input.projectId ? "project" : "personal",
            personalOwnerId: personalResourceOwnerId(ctx.identity),
            personalOwnerType: "human",
            limit: input.limit,
          }),
          createResourceServices(ctx.identity).documentService.searchDocumentsWithMetadata(ctx.db, {
            query: input.query,
            mode: input.mode,
            projectId: input.projectId,
            includeGlobal: true,
            includePersonal: !input.projectId,
            personalOwnerId: personalResourceOwnerId(ctx.identity),
            personalOwnerType: "human",
            limit: input.limit,
            keywordWeight: 0.3,
            fulltextWeight: 0.7,
          }),
          createResourceServices(ctx.identity).requirementService.searchRequirements(ctx.db, {
            query: input.query,
            projectId: input.projectId,
            limit: input.limit,
          }),
          Promise.resolve({ items: [] as Awaited<ReturnType<typeof repositoryService.listRepositories>>["items"] }),
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
