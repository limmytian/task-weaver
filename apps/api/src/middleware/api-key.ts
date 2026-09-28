import type { Context, Next } from "hono";
import type { Env } from "./actor";
import { apiKeyService } from "@task-weaver/core";

/**
 * Middleware that authenticates requests using Bearer token (API key).
 *
 * If a valid API key is found, it sets the actor to the key's agent identity.
 * If no Authorization header is present, the request falls through to the
 * default actor middleware (anonymous/human).
 *
 * Returns 401 for invalid or expired keys.
 */
export async function apiKeyMiddleware(c: Context<Env>, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // No API key — fall through to actor middleware defaults
    await next();
    return;
  }

  const rawKey = authHeader.slice(7);
  const db = c.get("db");

  const key = await apiKeyService.validateApiKey(db, rawKey);
  if (!key) {
    return c.json({ error: "Invalid or expired API key" }, 401);
  }

  // Override actor with API key identity
  c.set("actor", {
    id: `apikey:${key.id}`,
    type: "agent" as const,
  });

  await next();
}
