import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  addRequirementRepositorySchema,
  addTaskRepositorySchema,
  ConflictError,
  createRepositorySchema,
  listRepositoriesSchema,
  NotFoundError,
  repositoryReadinessInputSchema,
  reopenRequirementRepositoryDeliverySchema,
  createResourceServices,
  syncRequirementRepositoryForgeStateSchema,
  updateRepositorySchema,
  updateRequirementRepositoryDeliverySchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const repositoryRoutes = new Hono<Env>();

function serviceError(c: Context<Env>, error: unknown) {
  if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  throw error;
}

repositoryRoutes.get("/repositories", async (c) => {
  const query = c.req.query();
  const parsed = listRepositoriesSchema.safeParse({
    query: query.q ?? query.query,
    provider: query.provider,
    host: query.host,
    status: query.status,
    visibility: query.visibility,
    tags: query.tags ? query.tags.split(",").filter(Boolean) : undefined,
    sort: query.sort?.replace("-", "_"),
    page: query.page ? Number(query.page) : undefined,
    pageSize: query.pageSize ? Number(query.pageSize) : undefined,
  });
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.listRepositories(c.get("db"), parsed.data, c.get("actor")));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/repositories", async (c) => {
  const parsed = createRepositorySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    const repository = await createResourceServices(c.get("identity")).repositoryService.createRepository(c.get("db"), parsed.data, c.get("actor"));
    return c.json(repository, 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.get("/repositories/:id", async (c) => {
  const parsed = repositoryReadinessInputSchema.safeParse({
    nodeId: c.req.query("nodeId"),
    operation: c.req.query("operation"),
    transport: c.req.query("transport"),
  });
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.getRepository(
      c.get("db"), c.req.param("id"), c.get("actor"), parsed.data,
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.patch("/repositories/:id", async (c) => {
  const parsed = updateRepositorySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.updateRepository(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.delete("/repositories/:id", async (c) => {
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.archiveRepository(c.get("db"), c.req.param("id"), c.get("actor")));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.get("/repositories/:id/readiness", async (c) => {
  const parsed = repositoryReadinessInputSchema.safeParse({
    nodeId: c.req.query("nodeId"),
    operation: c.req.query("operation"),
    transport: c.req.query("transport"),
  });
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.getRepositoryReadiness(
      c.get("db"), c.req.param("id"), c.get("actor"), parsed.data,
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.get("/requirements/:id/repositories", async (c) => {
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.listRequirementRepositories(
      c.get("db"), c.req.param("id"), c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/requirements/:id/repositories", async (c) => {
  const parsed = addRequirementRepositorySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.addRequirementRepository(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ), 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.delete("/requirements/:id/repositories/:repositoryId", async (c) => {
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.removeRequirementRepository(
      c.get("db"), c.req.param("id"), c.req.param("repositoryId"), c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/requirement-repositories/:id/retry", async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(1000).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.retryRequirementRepositoryDelivery(
      c.get("db"), c.req.param("id"), c.get("actor"), parsed.data.reason,
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/requirement-repositories/:id/manual-handoff", async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(1000) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.handoffRequirementRepositoryDelivery(
      c.get("db"), c.req.param("id"), parsed.data.reason, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/requirement-repositories/:id/reopen", async (c) => {
  const parsed = reopenRequirementRepositoryDeliverySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.reopenRequirementRepositoryDelivery(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.patch("/requirement-repositories/:id/delivery", async (c) => {
  const parsed = updateRequirementRepositoryDeliverySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.updateRequirementRepositoryDelivery(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/requirement-repositories/:id/forge-sync", async (c) => {
  const parsed = syncRequirementRepositoryForgeStateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.syncRequirementRepositoryForgeState(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.get("/tasks/:id/repositories", async (c) => {
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.listTaskRepositories(
      c.get("db"), c.req.param("id"), c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.post("/tasks/:id/repositories", async (c) => {
  const parsed = addTaskRepositorySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.addTaskRepository(
      c.get("db"), c.req.param("id"), parsed.data, c.get("actor"),
    ), 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

repositoryRoutes.delete("/tasks/:id/repositories/:repositoryId", async (c) => {
  try {
    return c.json(await createResourceServices(c.get("identity")).repositoryService.removeTaskRepository(
      c.get("db"), c.req.param("id"), c.req.param("repositoryId"), c.get("actor"),
    ));
  } catch (error) {
    return serviceError(c, error);
  }
});

export default repositoryRoutes;
