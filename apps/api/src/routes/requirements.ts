import { Hono } from "hono";
import {
  claimService,
  requirementService,
  createRequirementSchema,
  updateRequirementSchema,
  listRequirementsSchema,
  linkDocumentToRequirementSchema,
  createRequirementDependencySchema,
  createExecutionSliceSchema,
  updateExecutionSliceSchema,
  batchCreateRequirementsSchema,
  claimRequirementSchema,
  heartbeatRequirementClaimSchema,
  releaseRequirementSchema,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const requirements = new Hono<Env>();

// GET /projects/:projectId/requirements - List requirements for a project
requirements.get("/projects/:projectId/requirements", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const query = c.req.query();
  const parsed = listRequirementsSchema.safeParse({
    ...query,
    projectId,
    query: query.q,
    completedWithinDays: query.completedWithinDays !== undefined
      ? Number(query.completedWithinDays)
      : undefined,
  });



  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await requirementService.listRequirements(db, parsed.data);
  return c.json(result);
});

// GET /projects/:projectId/requirements/heatmap - Get requirement heatmap for a project
requirements.get("/projects/:projectId/requirements/heatmap", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  const heatmap = await requirementService.getRequirementHeatmap(db, projectId);
  return c.json(heatmap);
});

// POST /projects/:projectId/requirements - Create a requirement
requirements.post("/projects/:projectId/requirements", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const parsed = createRequirementSchema.safeParse({ ...body, projectId });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const requirement = await requirementService.createRequirement(db, parsed.data, actor);
    return c.json(requirement, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// POST /requirements/batch - Batch create requirements
requirements.post("/requirements/batch", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = batchCreateRequirementsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const results = await requirementService.batchCreateRequirements(db, parsed.data, actor);
    return c.json(results, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /requirements/:id - Get requirement detail
requirements.get("/requirements/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const requirement = await requirementService.getRequirement(db, id);
    return c.json(requirement);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// PATCH /requirements/:id - Update requirement
requirements.patch("/requirements/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateRequirementSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const requirement = await requirementService.updateRequirement(db, id, parsed.data, actor);
    return c.json(requirement);
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

// DELETE /requirements/:id - Cancel requirement (soft delete)
requirements.delete("/requirements/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    const requirement = await requirementService.deleteRequirement(db, id, actor);
    return c.json(requirement);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /requirements/:id/claim - Claim a requirement lane
requirements.post("/requirements/:id/claim", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = claimRequirementSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const claim = await claimService.claimRequirement(
      db,
      id,
      actor,
      parsed.data.durationMinutes,
      {
        daemonId: parsed.data.daemonId,
        workerIndex: parsed.data.workerIndex,
      },
    );
    return c.json(claim, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// POST /requirements/:id/release - Release a claimed requirement lane
requirements.post("/requirements/:id/release", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = releaseRequirementSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await claimService.releaseRequirement(
      db,
      id,
      actor,
      parsed.data.reason,
      parsed.data.daemonId,
      parsed.data.leaseGeneration,
    );
    return c.json(result);
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

// POST /requirements/:id/heartbeat - Refresh requirement claim lease
requirements.post("/requirements/:id/heartbeat", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = heartbeatRequirementClaimSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const claim = await claimService.heartbeatRequirementClaim(
      db,
      id,
      actor,
      parsed.data.extendMinutes,
      parsed.data.daemonId,
      parsed.data.leaseGeneration,
    );
    return c.json(claim);
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

// GET /requirements/:id/claim - Get current requirement claim status
requirements.get("/requirements/:id/claim", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const claim = await claimService.getRequirementClaim(db, id);
  return c.json(claim ?? { claimed: false });
});

// GET /requirement-claims - List active requirement claims
requirements.get("/requirement-claims", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const claims = await claimService.listActiveRequirementClaims(db, {
    projectId: query.projectId,
    claimedBy: query.claimedBy,
  });
  return c.json(claims);
});

// GET /requirements/:id/dependencies - List requirement blockers and dependents
requirements.get("/requirements/:id/dependencies", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const result = await requirementService.listRequirementDependencies(db, id);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /requirements/:id/slices - List execution slices for a requirement
requirements.get("/requirements/:id/slices", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const result = await requirementService.listExecutionSlices(db, id);
    return c.json({ items: result });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /requirements/:id/slices - Create an execution slice
requirements.post("/requirements/:id/slices", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = createExecutionSliceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const slice = await requirementService.createExecutionSlice(db, id, parsed.data, actor);
    return c.json(slice, 201);
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

// PATCH /execution-slices/:id - Update an execution slice
requirements.patch("/execution-slices/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateExecutionSliceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const slice = await requirementService.updateExecutionSlice(db, id, parsed.data, actor);
    return c.json(slice);
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

// DELETE /execution-slices/:id - Delete an execution slice
requirements.delete("/execution-slices/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    const deleted = await requirementService.deleteExecutionSlice(db, id, actor);
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /requirements/:id/dependencies - Add requirement dependency
requirements.post("/requirements/:id/dependencies", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = createRequirementDependencySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const dep = await requirementService.addRequirementDependency(
      db,
      id,
      parsed.data.dependsOnRequirementId,
      parsed.data.type,
      actor,
      parsed.data.description,
    );
    return c.json(dep, 201);
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

// DELETE /requirements/:id/dependencies/:depId - Remove requirement dependency
requirements.delete("/requirements/:id/dependencies/:depId", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const depId = c.req.param("depId");

  try {
    const deleted = await requirementService.removeRequirementDependency(db, depId, actor);
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /requirements/:id/document-links - Link a document to a requirement
requirements.post("/requirements/:id/document-links", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const requirementId = c.req.param("id");
  const body = await c.req.json();
  const parsed = linkDocumentToRequirementSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const link = await requirementService.linkDocumentToRequirement(
      db,
      requirementId,
      parsed.data.documentId,
      parsed.data.linkType,
      actor,
    );
    return c.json(link, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /requirements/:id/burndown - Get requirement burndown chart data
requirements.get("/requirements/:id/burndown", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const burndown = await requirementService.getRequirementBurndown(db, id);
    return c.json(burndown);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /requirements/:id/document-links/:linkId - Remove document link from requirement
requirements.delete("/requirements/:id/document-links/:linkId", async (c) => {
  const linkId = c.req.param("linkId");

  try {
    const deleted = await requirementService.unlinkDocumentFromRequirement(c.get("db"), linkId);
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

export default requirements;
