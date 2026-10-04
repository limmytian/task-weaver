import { z } from "zod";
import { router, publicProcedure } from "../init";
import { activityLogService } from "@task-weaver/core";

export const activityRouter = router({
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        entityType: z
          .enum(["project", "task", "document", "requirement", "repository", "daemon", "schedule", "ti_agent_model_config", "ti_agent_policy", "ti_agent_run"])
          .optional(),
        entityId: z.string().uuid().optional(),
        actorId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      return activityLogService.listActivityLog(ctx.db, input);
    }),
});
