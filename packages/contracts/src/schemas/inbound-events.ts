import { z } from "zod";
import { taskPrioritySchema, taskStatusSchema } from "./tasks";

const path = z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}$/)
  .refine(value => !value.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part)), "Invalid event path");
const target = z.union([z.object({ taskId: z.string().uuid() }).strict(), z.object({ taskIdPath: path }).strict()]);
const template = z.string().min(1).max(4000);
export const inboundActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_task"), title: z.string().min(1).max(500), description: template.optional(), priority: taskPrioritySchema.optional() }).strict(),
  z.object({ type: z.literal("add_comment"), target, content: template }).strict(),
  z.object({ type: z.literal("update_task"), target, changes: z.object({ title: z.string().min(1).max(500).optional(), description: template.optional(), priority: taskPrioritySchema.optional(), status: taskStatusSchema.optional() }).strict() }).strict(),
  z.object({ type: z.literal("record_evidence"), target, content: template }).strict(),
  z.object({ type: z.literal("run_schedule"), scheduleId: z.string().uuid() }).strict(),
]);
export const inboundRuleSchema = z.object({
  id: z.string().uuid(), eventTypes: z.array(z.string().min(1).max(100)).min(1).max(20),
  conditions: z.array(z.object({ path, operator: z.enum(["equals", "not_equals", "exists"]), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]).optional() }).strict().refine(condition => condition.operator === "exists" || Object.hasOwn(condition, "value"), "Comparison conditions require a value")).max(10).default([]),
  actions: z.array(inboundActionSchema).min(1).max(10),
}).strict();
export const createInboundSourceSchema = z.object({
  name: z.string().min(1).max(200), projectId: z.string().uuid(), requirementId: z.string().uuid(),
  active: z.boolean().default(true), rules: z.array(inboundRuleSchema).min(1).max(20).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, "Rule IDs must be unique"),
}).strict();
export const updateInboundSourceSchema = createInboundSourceSchema.omit({ projectId: true, requirementId: true }).partial().extend({ active: createInboundSourceSchema.shape.active.removeDefault().optional(), rotateSecret: z.boolean().optional() }).strict();
export const inboundEventSchema = z.object({
  eventId: z.string().min(1).max(200), type: z.string().min(1).max(100), occurredAt: z.string().datetime().optional(),
  data: z.record(z.string(), z.unknown()),
}).strict();
export const listInboundEventsSchema = z.object({ limit: z.coerce.number<number>().int().min(1).max(100).default(20), offset: z.coerce.number<number>().int().min(0).default(0) }).strict();
export type InboundAction = z.infer<typeof inboundActionSchema>;
export type InboundRule = z.infer<typeof inboundRuleSchema>;
export type InboundEvent = z.infer<typeof inboundEventSchema>;
