import type { Context, Next } from "hono";
import type { Database } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type { VerifiedRequestContext } from "@task-weaver/contracts";
import type { AuthenticationRuntime } from "@task-weaver/core";

export type Env = {
  Variables: {
    db: Database;
    actor: Actor;
    identity: VerifiedRequestContext;
    auth: AuthenticationRuntime;
  };
};

/** Historical Actor attribution is projected only from a server-verified principal. */
export async function actorMiddleware(c: Context<Env>, next: Next) {
  const identity = await c.get("auth").verify(c.req.raw.headers);
  c.set("identity", identity);
  c.set("actor", { id: identity.actor.id, type: identity.actor.type });
  await next();
}
