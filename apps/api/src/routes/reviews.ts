import { Hono, type Context } from "hono";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createReviewRunSchema,
  evaluateReviewRunSchema,
  listReviewRunsSchema,
  recordReviewDecisionSchema,
  reviewPolicyInputSchema,
  reviewService,
  upsertReviewCheckSchema,
  upsertReviewFindingSchema,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const reviews = new Hono<Env>();

function serviceError(c: Context<Env>, error: unknown) {
  if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  throw error;
}

reviews.get("/projects/:projectId/review-policy", async (c) => {
  try {
    return c.json(await reviewService.getProjectReviewPolicy(c.get("db"), c.req.param("projectId")));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.put("/projects/:projectId/review-policy", async (c) => {
  const parsed = reviewPolicyInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.upsertProjectReviewPolicy(
      c.get("db"), c.req.param("projectId"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.get("/requirements/:requirementId/review-policy", async (c) => {
  try {
    return c.json(await reviewService.getEffectiveReviewPolicy(
      c.get("db"), c.req.param("requirementId"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.put("/requirements/:requirementId/review-policy", async (c) => {
  const parsed = reviewPolicyInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.upsertRequirementReviewPolicy(
      c.get("db"), c.req.param("requirementId"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.get("/requirements/:requirementId/review-runs", async (c) => {
  const parsed = listReviewRunsSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.listRequirementReviewRuns(
      c.get("db"), c.req.param("requirementId"), parsed.data,
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.post("/requirements/:requirementId/review-runs", async (c) => {
  const parsed = createReviewRunSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    const run = await reviewService.startReviewRun(
      c.get("db"), c.req.param("requirementId"), parsed.data, c.get("actor"),
    );
    return c.json(run, 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.get("/review-runs/:id", async (c) => {
  try {
    return c.json(await reviewService.getReviewRun(c.get("db"), c.req.param("id")));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.put("/review-runs/:id/checks", async (c) => {
  const parsed = upsertReviewCheckSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.upsertReviewCheck(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.put("/review-runs/:id/findings", async (c) => {
  const parsed = upsertReviewFindingSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.upsertReviewFinding(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.post("/review-runs/:id/decisions", async (c) => {
  const parsed = recordReviewDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    const decision = await reviewService.recordReviewDecision(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    );
    return c.json(decision, 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

reviews.post("/review-runs/:id/evaluate", async (c) => {
  const parsed = evaluateReviewRunSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await reviewService.evaluateReviewRun(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

export default reviews;
