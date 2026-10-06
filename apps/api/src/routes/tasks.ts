import { Hono } from "hono";
import {
  createResourceServices,
  personalResourceOwnerId,
  recommendationService,
  createTaskSchema,
  createPersonalTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  listTasksSchema,
  createTaskCommentSchema,
  createTaskNoteSchema,
  createTaskDependencySchema,
  batchCreateTasksSchema,
  batchUpdateTasksSchema,
  claimTaskSchema,
  releaseTaskSchema,
  batchClaimTasksSchema,
  NotFoundError,
  ValidationError,
  ConflictError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const tasks = new Hono<Env>();

// ---- Project-scoped routes ----

// GET /projects/:projectId/tasks - List tasks with filters
tasks.get("/projects/:projectId/tasks", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const query = c.req.query();

  const parsed = listTasksSchema.safeParse({
    scope: "project",
    projectId,
    status: query.status,
    assignee: query.assignee,
    priority: query.priority,
    tag: query.tag,
    requirementId: query.requirementId,
    query: query.q,
    view: query.view,
    page: query.page,
    pageSize: query.pageSize,
    completedWithinDays: query.completedWithinDays !== undefined
      ? Number(query.completedWithinDays)
      : undefined,
  });


  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).taskService.listTasks(db, parsed.data);
    return c.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// POST /projects/:projectId/tasks - Create a task
tasks.post("/projects/:projectId/tasks", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");
  const body = await c.req.json();

  const parsed = createTaskSchema.safeParse({ ...body, scope: "project", projectId });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const task = await createResourceServices(c.get("identity")).taskService.createTask(db, parsed.data, actor);
    return c.json(task, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// GET /personal/tasks - List personal tasks for the current actor
tasks.get("/personal/tasks", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = listTasksSchema.safeParse({
    scope: "personal",
    personalOwnerId: query.ownerId ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: query.ownerType ?? "human",
    status: query.status,
    assignee: query.assignee,
    priority: query.priority,
    tag: query.tag,
    query: query.q,
    view: query.view,
    page: query.page,
    pageSize: query.pageSize,
    completedWithinDays: query.completedWithinDays !== undefined
      ? Number(query.completedWithinDays)
      : undefined,
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).taskService.listTasks(db, parsed.data);
    return c.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// POST /personal/tasks - Create a personal task for the current actor
tasks.post("/personal/tasks", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = createPersonalTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const task = await createResourceServices(c.get("identity")).taskService.createPersonalTask(db, parsed.data, actor);
  return c.json(task, 201);
});

// GET /projects/:projectId/board - Get kanban board
tasks.get("/projects/:projectId/board", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const query = c.req.query();
  const completedWithinDays = query.completedWithinDays
    ? Number(query.completedWithinDays)
    : undefined;
  const includeTerminal = query.includeTerminal === "true" || query.includeTerminal === "1";

  const board = await createResourceServices(c.get("identity")).taskService.getKanbanBoard(db, projectId, { includeTerminal, completedWithinDays });
  return c.json(board);
});

// GET /projects/:projectId/gantt - Get gantt chart data
tasks.get("/projects/:projectId/gantt", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");

  const gantt = await createResourceServices(c.get("identity")).taskService.getGanttChart(db, projectId);
  return c.json(gantt);
});

// ---- Batch routes ----

// POST /tasks/batch - Batch create tasks
tasks.post("/tasks/batch", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = batchCreateTasksSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const results = await createResourceServices(c.get("identity")).taskService.batchCreateTasks(db, parsed.data, actor);
    return c.json(results, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// PATCH /tasks/batch - Batch update tasks
tasks.patch("/tasks/batch", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = batchUpdateTasksSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const results = await createResourceServices(c.get("identity")).taskService.batchUpdateTasks(db, parsed.data, actor);
    return c.json(results);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// ---- Task-scoped routes ----

// GET /tasks/:id - Get task detail
tasks.get("/tasks/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const task = await createResourceServices(c.get("identity")).taskService.getTaskDetail(db, id);
    return c.json(task);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    throw err;
  }
});

// PATCH /tasks/:id - Update task
tasks.patch("/tasks/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const task = await createResourceServices(c.get("identity")).taskService.updateTask(db, id, parsed.data, actor);
    return c.json(task);
  } catch (err) {
    if (err instanceof ConflictError) {
      return c.json({ error: err.message, currentVersion: err.currentVersion }, 409);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// PATCH /tasks/:id/status - Change task status
tasks.patch("/tasks/:id/status", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateTaskStatusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const task = await createResourceServices(c.get("identity")).taskService.updateTaskStatus(
      db,
      id,
      parsed.data.status,
      actor,
      parsed.data.reason,
      parsed.data.force,
      {
        leaseGeneration: parsed.data.leaseGeneration,
        daemonId: parsed.data.daemonId,
      },
    );
    return c.json(task);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// DELETE /tasks/:id - Cancel task (soft delete)
tasks.delete("/tasks/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    const task = await createResourceServices(c.get("identity")).taskService.deleteTask(db, id, actor);
    return c.json(task);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// POST /tasks/:id/comments - Add comment to task
tasks.post("/tasks/:id/comments", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = createTaskCommentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const comment = await createResourceServices(c.get("identity")).taskService.addTaskComment(db, id, parsed.data.content, actor);
    return c.json(comment, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    throw err;
  }
});

// POST /tasks/:id/notes - Add note to task
tasks.post("/tasks/:id/notes", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = createTaskNoteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const note = await createResourceServices(c.get("identity")).taskService.addTaskNote(
      db,
      id,
      parsed.data.content,
      parsed.data.pinned,
      actor,
    );
    return c.json(note, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    throw err;
  }
});

// POST /tasks/:id/dependencies - Add dependency
tasks.post("/tasks/:id/dependencies", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = createTaskDependencySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const dep = await createResourceServices(c.get("identity")).taskService.addTaskDependency(
      db,
      id,
      parsed.data.dependsOnTaskId,
      parsed.data.type,
      actor,
      parsed.data.description,
    );
    return c.json(dep, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// DELETE /tasks/:id/dependencies/:depId - Remove dependency
tasks.delete("/tasks/:id/dependencies/:depId", async (c) => {
  const db = c.get("db");
  const depId = c.req.param("depId");

  try {
    const deleted = await createResourceServices(c.get("identity")).taskService.removeTaskDependency(db, depId, c.req.param("id"));
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    throw err;
  }
});

// POST /tasks/:id/claim - Claim a task (acquire lease)
tasks.post("/tasks/:id/claim", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = claimTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const claim = await createResourceServices(c.get("identity")).claimService.claimTask(db, id, actor, parsed.data.durationMinutes);
    return c.json(claim, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// POST /tasks/:id/release - Release a claimed task
tasks.post("/tasks/:id/release", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = releaseTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).claimService.releaseTask(db, id, actor, parsed.data.reason);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// POST /tasks/:id/heartbeat - Refresh claim lease
tasks.post("/tasks/:id/heartbeat", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const extendMinutes = typeof body.extendMinutes === "number" ? body.extendMinutes : 30;

  try {
    const claim = await createResourceServices(c.get("identity")).claimService.heartbeatClaim(db, id, actor, extendMinutes);
    return c.json(claim);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    throw err;
  }
});

// GET /tasks/:id/claim - Get current claim status
tasks.get("/tasks/:id/claim", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const claim = await createResourceServices(c.get("identity")).claimService.getTaskClaim(db, id);
  return c.json(claim ?? { claimed: false });
});

// GET /claims - List all active claims (filterable by projectId, claimedBy)
tasks.get("/claims", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const claims = await createResourceServices(c.get("identity")).claimService.listActiveClaims(db, {
    projectId: query.projectId,
    claimedBy: query.claimedBy,
  });
  return c.json(claims);
});

// POST /claims/batch - Atomically claim multiple tasks (all-or-nothing)
tasks.post("/claims/batch", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = batchClaimTasksSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const claims = await createResourceServices(c.get("identity")).claimService.batchClaimTasks(
      db,
      parsed.data.taskIds,
      actor,
      parsed.data.durationMinutes,
    );
    return c.json(claims, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /tasks/:id/recommendations - Get recommended links for a task
tasks.get("/tasks/:id/recommendations", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const query = c.req.query();

  const limit = query.limit ? Number(query.limit) : undefined;
  const types = query.types
    ? (query.types.split(",") as ("document" | "task" | "requirement")[])
    : undefined;
  const threshold = query.threshold ? Number(query.threshold) : undefined;

  try {
    const result = await recommendationService.getTaskRecommendations(
      db,
      id,
      { limit, types, threshold },
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Resource not found" }, 404);
    }
    throw err;
  }
});

export default tasks;
