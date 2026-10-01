import type { Context, Next } from "hono";
import type { Database } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import { resolveActor } from "@task-weaver/contracts";

export type Env = {
  Variables: {
    db: Database;
    actor: Actor;
  };
};

/**
 * Middleware that extracts actor information from request headers.
 *
 * Reads `X-Actor-Id` and `X-Actor-Type` headers and sets defaults
 * of "anonymous" / "human" when not provided.
 *
 * If an actor has already been set (e.g. by API key middleware),
 * this middleware will not overwrite it.
 */
export async function actorMiddleware(
  c: Context<Env>,
  next: Next,
) {
  // Skip if actor is already set (e.g. by apiKeyMiddleware)
  try {
    const existing = c.get("actor");
    if (existing) {
      await next();
      return;
    }
  } catch {
    // c.get throws if variable not set — continue to set it
  }

  c.set("actor", resolveActor({
    "x-actor-id": c.req.header("X-Actor-Id"),
    "x-actor-type": c.req.header("X-Actor-Type"),
  }));

  await next();
}
