import { Hono } from "hono";
import {
  applyPlanSchema,
  planService,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const plans = new Hono<Env>();

// POST /plans/apply - Validate or atomically apply a project plan
plans.post("/apply", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = applyPlanSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await planService.applyPlan(db, parsed.data, actor);
    return c.json(result, parsed.data.dryRun ? 200 : 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

export default plans;
