import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  projectService,
  requirementService,
  createProjectSchema,
  updateProjectSchema,
  listProjectsSchema,
} from "@task-weaver/core";

export const projectRouter = router({
  list: publicProcedure
    .input(listProjectsSchema.optional())
    .query(async ({ ctx, input }) => {
      return projectService.listProjects(ctx.db, input);
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return projectService.getProject(ctx.db, input.id);
    }),

  create: publicProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      return projectService.createProject(ctx.db, input, ctx.actor);
    }),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateProjectSchema }))
    .mutation(async ({ ctx, input }) => {
      return projectService.updateProject(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return projectService.deleteProject(ctx.db, input.id, ctx.actor);
    }),

  counts: publicProcedure
    .input(z.object({ projectIds: z.array(z.string().uuid()).min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      return projectService.getProjectCounts(ctx.db, input.projectIds);
    }),

  stats: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return projectService.getProjectStats(ctx.db, input.id);
    }),

  health: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return projectService.getProjectHealthDashboard(ctx.db, input.id);
    }),

  knowledgeGraph: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return projectService.getKnowledgeGraph(ctx.db, input.id);
    }),

  heatmap: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return requirementService.getRequirementHeatmap(ctx.db, input.id);
    }),

  pinned: publicProcedure
    .query(async ({ ctx }) => {
      return projectService.listPinnedProjects(ctx.db);
    }),

  togglePin: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return projectService.togglePin(ctx.db, input.id);
    }),
});
