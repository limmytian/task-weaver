import type { Context, Next } from "hono";
import {
  AuthorizationDeniedError,
  EntitlementDeniedError,
  enforceAccess,
} from "@task-weaver/module-sdk/ports";
import type { Env } from "./actor";

export async function accessControlMiddleware(c: Context<Env>, next: Next) {
  const path = new URL(c.req.url).pathname;
  try {
    await enforceAccess(c.get("ports"), {
      authorization: {
        actor: c.get("actor"),
        permission: `http.${c.req.method.toLowerCase()}`,
        resource: { type: "http_route", id: path },
        context: { path },
      },
      entitlement: {
        capability: "core.api",
        scope: { type: "http_route", id: path },
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationDeniedError || error instanceof EntitlementDeniedError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
  await next();
}
