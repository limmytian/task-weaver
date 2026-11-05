import { Hono } from "hono";
import { z } from "zod";
import { createReassessmentGrantService, createReassessmentDecisionService, createInterruptedReassessmentService, reassessmentGrantInputSchema, reassessmentDecisionInputSchema, reassessmentApplyInputSchema, interruptedReassessmentInputSchema } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const routes = new Hono<Env>();
const id = z.string().uuid();
const grantInput = reassessmentGrantInputSchema.extend({ expiresAt: z.iso.datetime().transform(value => new Date(value)) });
routes.post("/grants", async c => {
  const input = grantInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid grant" }, 400);
  return c.json(await createReassessmentGrantService(c.get("identity")).create(c.get("db"), input.data), 201);
});
routes.get("/grants", async c => {
  const projectId = id.safeParse(c.req.query("projectId"));
  if (!projectId.success) return c.json({ error: "Invalid project" }, 400);
  return c.json(await createReassessmentGrantService(c.get("identity")).list(c.get("db"), projectId.data));
});
routes.post("/grants/:id/revoke", async c => {
  const input = z.object({ projectId: id }).strict().safeParse(await c.req.json().catch(() => null));
  const grantId = id.safeParse(c.req.param("id"));
  if (!input.success || !grantId.success) return c.json({ error: "Invalid grant" }, 400);
  return c.json(await createReassessmentGrantService(c.get("identity")).revoke(c.get("db"), input.data.projectId, grantId.data));
});
routes.post("/decisions", async c => {
  const input = reassessmentDecisionInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid decision" }, 400);
  return c.json(await createReassessmentDecisionService(c.get("identity")).record(c.get("db"), input.data), 201);
});
routes.post("/interrupted", async c => {
  const input = interruptedReassessmentInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid interrupted execution assessment" }, 400);
  return c.json(await createInterruptedReassessmentService(c.get("identity")).record(c.get("db"), input.data), 201);
});
routes.post("/apply", async c => {
  const input = reassessmentApplyInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid application" }, 400);
  return c.json(await createReassessmentDecisionService(c.get("identity")).apply(c.get("db"), input.data));
});
routes.get("/decisions", async c => {
  const requirementId = id.safeParse(c.req.query("requirementId"));
  if (!requirementId.success) return c.json({ error: "Invalid requirement" }, 400);
  return c.json(await createReassessmentDecisionService(c.get("identity")).inspect(c.get("db"), requirementId.data));
});
export default routes;
