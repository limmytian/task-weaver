import { z } from "zod";
import {
  agentUsageQuerySchema,
  agentUsageService,
  projectService,
  requirementService,
  taskService,
} from "@task-weaver/core";
import { router, publicProcedure } from "../init";
// Read access follows the existing instance Web boundary; reporting is REST API-key only.
export const agentUsageRouter = router({
  scopes: publicProcedure
    .input(
      z.object({
        kind: z.enum(["project", "requirement", "task"]),
        projectId: z.string().uuid().optional(),
        requirementId: z.string().uuid().optional(),
        query: z.string().trim().max(500).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.kind === "project") {
        const result = await projectService.listProjects(ctx.db, {
          view: "summary",
          pageSize: 50,
          query: input.query || undefined,
        });
        return z
          .array(z.object({ id: z.string().uuid(), name: z.string() }))
          .parse(result.items)
          .map((item) => ({ id: item.id, label: item.name }));
      }
      if (!input.projectId) return [];
      if (input.kind === "requirement") {
        const result = await requirementService.listRequirements(ctx.db, {
          projectId: input.projectId,
          view: "summary",
          pageSize: 50,
          completedWithinDays: 0,
          query: input.query || undefined,
        });
        return z
          .array(z.object({ id: z.string().uuid(), title: z.string() }))
          .parse(result.items)
          .map((item) => ({ id: item.id, label: item.title }));
      }
      const result = await taskService.listTasks(ctx.db, {
        projectId: input.projectId,
        requirementId: input.requirementId,
        view: "summary",
        pageSize: 50,
        completedWithinDays: 0,
        query: input.query || undefined,
      });
      return z
        .array(z.object({ id: z.string().uuid(), title: z.string() }))
        .parse(result.items)
        .map((item) => ({ id: item.id, label: item.title }));
    }),
  runs: publicProcedure
    .input(agentUsageQuerySchema)
    .query(({ ctx, input }) => agentUsageService.listUsage(ctx.db, input)),
  summary: publicProcedure
    .input(agentUsageQuerySchema)
    .query(({ ctx, input }) => agentUsageService.summarizeUsage(ctx.db, input)),
  run: publicProcedure
    .input(
      z.object({ projectId: z.string().uuid(), processId: z.string().uuid() }),
    )
    .query(({ ctx, input }) =>
      agentUsageService.getUsage(ctx.db, input.projectId, input.processId),
    ),
});
