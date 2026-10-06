import { z } from "zod";

export const webhookEventTypes = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.commented",
  "task.deleted",
  "requirement.created",
  "requirement.updated",
  "requirement.deleted",
  "document.created",
  "document.updated",
  "document.deleted",
  "document.linked",
] as const;

export const webhookEventTypeSchema = z.enum(webhookEventTypes);

export const createWebhookSchema = z.object({
  projectId: z.string().uuid().optional(),
  url: z.string().url(),
  events: z.array(webhookEventTypeSchema).min(1),
  secret: z.string().min(16).optional(),
  active: z.boolean().default(true),
  description: z.string().max(500).optional(),
}).strict();

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(webhookEventTypeSchema).min(1).optional(),
  active: z.boolean().optional(),
  description: z.string().max(500).nullable().optional(),
  rotateSecret: z.boolean().optional(),
}).strict();

export const listWebhooksSchema = z.object({
  projectId: z.string().uuid().optional(),
  active: z
    .string()
    .transform((v) => v === "true")
    .optional(),
}).strict();

export const listWebhookDeliveriesSchema = z.object({
  status: z.enum(["pending", "success", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
}).strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
