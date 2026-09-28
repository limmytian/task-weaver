import { Hono } from "hono";
import { apiKeyService, NotFoundError } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";
import { z } from "zod";

const apiKeysRouter = new Hono<Env>();

const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  permissions: z.record(z.boolean()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const rotateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  expiresAt: z.string().datetime().optional(),
});

// GET / - List all API keys (never returns raw key)
apiKeysRouter.get("/", async (c) => {
  const db = c.get("db");
  const keys = await apiKeyService.listApiKeys(db);
  return c.json(keys);
});

// POST / - Create a new API key (returns raw key once)
apiKeysRouter.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();
  const parsed = createApiKeySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await apiKeyService.createApiKey(db, {
    name: parsed.data.name,
    permissions: parsed.data.permissions,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
  });

  return c.json(result, 201);
});

// POST /:id/rotate - Rotate an API key (revoke old, create new atomically)
apiKeysRouter.post("/:id/rotate", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = rotateApiKeySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await apiKeyService.rotateApiKey(db, id, {
      name: parsed.data.name,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /:id - Revoke an API key
apiKeysRouter.delete("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const result = await apiKeyService.revokeApiKey(db, id);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

export default apiKeysRouter;
