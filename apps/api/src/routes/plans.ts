import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  applyPlanSchema,
  createPlanDraftSchema,
  updatePlanDraftSchema,
  ConflictError,
  createResourceServices,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const plans = new Hono<Env>();

plans.use("/drafts/*", bodyLimit({ maxSize: 1024 * 1024 + 16 * 1024, onError: c => c.json({ error: "Request exceeds the staging limit" }, 413) }));
plans.use("/drafts", bodyLimit({ maxSize: 1024 * 1024 + 16 * 1024, onError: c => c.json({ error: "Request exceeds the staging limit" }, 413) }));
const draftKey = z.object({ projectId: z.string().uuid(), draftId: z.string().uuid() });
const draftRevision = draftKey.extend({ revision: z.number().int().positive() });

plans.post("/drafts", async c => {
  const parsed = createPlanDraftSchema.safeParse({ ...(await c.req.json()), source: "web" });
  if (!parsed.success) return c.json({ error: "Invalid plan draft" }, 400);
  return c.json(await createResourceServices(c.get("identity")).planService.createPlanDraft(c.get("db"), parsed.data, c.get("actor")), 201);
});
plans.get("/drafts", async c => {
  const parsed = z.string().uuid().safeParse(c.req.query("projectId"));
  if (!parsed.success) return c.json({ error: "Invalid project" }, 400);
  return c.json(await createResourceServices(c.get("identity")).planService.listPlanDrafts(c.get("db"), parsed.data));
});
plans.get("/drafts/:id", async c => {
  const parsed = draftKey.safeParse({ projectId: c.req.query("projectId"), draftId: c.req.param("id") });
  if (!parsed.success) return c.json({ error: "Invalid draft reference" }, 400);
  return c.json(await createResourceServices(c.get("identity")).planService.getPlanDraft(c.get("db"), parsed.data.projectId, parsed.data.draftId));
});
plans.get("/drafts/:id/receipt", async c => {
  const parsed = draftKey.safeParse({ projectId: c.req.query("projectId"), draftId: c.req.param("id") });
  if (!parsed.success) return c.json({ error: "Invalid draft reference" }, 400);
  return c.json(await createResourceServices(c.get("identity")).planService.getPlanDraftReceipt(c.get("db"), parsed.data.projectId, parsed.data.draftId));
});
plans.put("/drafts/:id", async c => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  const parsed = updatePlanDraftSchema.safeParse(await c.req.json());
  if (!id.success || !parsed.success) return c.json({ error: "Invalid plan draft" }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).planService.updatePlanDraft(c.get("db"), id.data, parsed.data, c.get("actor")));
  } catch (error) {
    if (error instanceof ConflictError) return c.json({ error: error.message, currentVersion: error.currentVersion }, 409);
    throw error;
  }
});
plans.post("/drafts/:id/discard", async c => {
  const parsed = draftRevision.safeParse({ ...(await c.req.json()), draftId: c.req.param("id") });
  if (!parsed.success) return c.json({ error: "Invalid draft reference" }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).planService.discardPlanDraft(c.get("db"), parsed.data.projectId, parsed.data.draftId, parsed.data.revision, c.get("actor")));
  } catch (error) {
    if (error instanceof ConflictError) return c.json({ error: error.message, currentVersion: error.currentVersion }, 409);
    throw error;
  }
});
plans.post("/drafts/:id/validate", async c => {
  const parsed = draftKey.safeParse({ ...(await c.req.json()), draftId: c.req.param("id") });
  if (!parsed.success) return c.json({ error: "Invalid draft reference" }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).planService.validatePlanDraft(c.get("db"), parsed.data.projectId, parsed.data.draftId, c.get("actor")));
  } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

plans.post("/drafts/:id/apply", async c => {
  const parsed = draftRevision.extend({ operationKey: z.string().uuid() }).safeParse({ ...(await c.req.json()), draftId: c.req.param("id") });
  if (!parsed.success) return c.json({ error: "Invalid draft reference" }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).planService.applyPlanDraft(c.get("db"), parsed.data.projectId, parsed.data.draftId, parsed.data.revision, parsed.data.operationKey, c.get("actor")));
  } catch (error) {
    if (error instanceof ConflictError) return c.json({ error: error.message, currentVersion: error.currentVersion }, 409);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

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
    const result = await createResourceServices(c.get("identity")).planService.applyPlan(db, parsed.data, actor);
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
