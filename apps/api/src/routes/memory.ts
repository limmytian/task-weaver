import { Hono } from "hono";
import {
  memoryService,
  recordMemorySchema,
  updateMemorySchema,
  searchMemorySchema,
  listMemoriesSchema,
  NotFoundError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const memory = new Hono<Env>();

// POST / — Record a memory
memory.post("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = recordMemorySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await memoryService.recordMemory(db, parsed.data, actor);
  return c.json(result, 201);
});

// GET /search — Search memories by query
memory.get("/search", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();

  const parsed = searchMemorySchema.safeParse({
    ...query,
    tags: query.tags ? query.tags.split(",") : undefined,
    preferredActorId: query.preferredActorId ?? actor.id,
    personalOwnerId: query.personalOwnerId ?? actor.id,
    personalOwnerType: query.personalOwnerType ?? actor.type,
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await memoryService.searchMemories(db, parsed.data);
  return c.json({ items: results });
});

// GET / — List memories with filters
memory.get("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();

  const parsed = listMemoriesSchema.safeParse({
    ...query,
    tags: query.tags ? query.tags.split(",") : undefined,
    personalOwnerId: query.personalOwnerId ?? actor.id,
    personalOwnerType: query.personalOwnerType ?? actor.type,
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await memoryService.listMemories(db, parsed.data);
  return c.json({ items: results });
});

// GET /entity/:type/:id — Get memories for a specific entity
memory.get("/entity/:entityType/:entityId", async (c) => {
  const db = c.get("db");
  const entityType = c.req.param("entityType");
  const entityId = c.req.param("entityId");

  const results = await memoryService.getMemoriesForEntity(db, entityType, entityId);
  return c.json({ items: results });
});

// PATCH /:id — Update a memory
memory.patch("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateMemorySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await memoryService.updateMemory(db, id, parsed.data, actor);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// DELETE /:id — Forget a memory
memory.delete("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    await memoryService.forgetMemory(db, id, actor);
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /:id — Get memory detail
memory.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const result = await memoryService.getMemory(db, id);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

export default memory;
