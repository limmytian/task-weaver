import { z } from "zod";

export const activityQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  entityType: z.enum(["project", "task", "document", "requirement", "repository", "daemon", "schedule", "ti_agent_model_config", "ti_agent_policy", "ti_agent_run", "assistant_conversation", "assistant_message", "assistant_action"]).optional(),
  entityId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  actorType: z.enum(["human", "agent"]).optional(),
  action: z.string().min(1).max(200).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
