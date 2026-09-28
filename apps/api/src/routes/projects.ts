import { Hono } from "hono";
import {
  projectService,
  createProjectSchema,
  updateProjectSchema,
  listProjectsSchema,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const projects = new Hono<Env>();

// GET / - List projects with optional status filter
projects.get("/", async (c) => {
  const db = c.get("db");
  const query = c.req.query();
  const parsed = listProjectsSchema.safeParse(query);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await projectService.listProjects(db, parsed.data);
  return c.json(result);
});

// POST / - Create a new project
projects.post("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const project = await projectService.createProject(db, parsed.data, actor);
    return c.json(project, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /:id - Get project detail
projects.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const project = await projectService.getProject(db, id);
    return c.json(project);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// PATCH /:id - Update project
projects.patch("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const project = await projectService.updateProject(db, id, parsed.data, actor);
    return c.json(project);
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

// GET /:id/stats - Get project statistics
projects.get("/:id/stats", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const stats = await projectService.getProjectStats(db, id);
    return c.json(stats);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/health - Get project health dashboard
projects.get("/:id/health", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const health = await projectService.getProjectHealthDashboard(db, id);
    return c.json(health);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/knowledge-graph - Get knowledge graph data
projects.get("/:id/knowledge-graph", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const graph = await projectService.getKnowledgeGraph(db, id);
    return c.json(graph);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /:id - Archive project (soft delete)
projects.delete("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    const project = await projectService.deleteProject(db, id, actor);
    return c.json(project);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

export default projects;
