import type { Context, Next } from "hono";
import {
  AuthorizationError,
  requireResourceAuthorization,
} from "@task-weaver/core";
import { actorMiddleware, type Env } from "./actor.js";

import { isOrdinaryResourceRoute } from "./resource-routes.js";

const publicRoutes = new Set([
  "GET /health",
  "GET /api/v1/version",
  "GET /api/v1/version/",
  "GET /api/v1/auth/csrf",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/bootstrap",
  "POST /api/v1/auth/activate",
]);
const guardedLifecycle = (path: string) =>
  path === "/api/v1/version/check" ||
  path.startsWith("/api/v1/auth/") ||
  path === "/api/v1/graphql" ||
  path === "/api/v1/graphql/" ||
  path === "/api/v1/api-keys" ||
  path.startsWith("/api/v1/api-keys/");

export async function authenticationMiddleware(c: Context<Env>, next: Next) {
  const headers = c.req.raw.headers;
  const origin = headers.get("origin");
  const trusted = origin !== null && c.get("auth").trustedOrigins.has(origin);
  c.header("cache-control", "no-store");
  c.header("vary", "Origin");
  c.get("auth").assertOrigin(headers);
  if (trusted) {
    c.header("access-control-allow-origin", origin!);
    c.header("access-control-allow-credentials", "true");
  }
  if (c.req.method === "OPTIONS") {
    if (headers.has("authorization")) await c.get("auth").verify(headers);
    if (!trusted || !c.req.path.startsWith("/api/v1/"))
      throw new AuthorizationError("csrf_rejected");
    const method = headers.get("access-control-request-method");
    const requested = (headers.get("access-control-request-headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !method ||
      !["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ||
      requested.some(
        (name) =>
          !["authorization", "content-type", "x-csrf-token"].includes(name),
      )
    )
      throw new AuthorizationError("csrf_rejected");
    c.header(
      "vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    c.header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE");
    c.header(
      "access-control-allow-headers",
      "Authorization, Content-Type, X-CSRF-Token",
    );
    return c.body(null, 204);
  }
  if (publicRoutes.has(`${c.req.method} ${c.req.path}`)) {
    // Explicit public authentication endpoints may accept an expired browser cookie for a new login.
    // An Authorization header is never silently discarded, even on public routes.
    if (headers.has("authorization")) await c.get("auth").verify(headers);
    await next();
    return;
  }
  await actorMiddleware(c, async () => {
    if (!["GET", "HEAD"].includes(c.req.method))
      c.get("auth").authentication.assertMutation(headers);
    if (!guardedLifecycle(c.req.path) && !isOrdinaryResourceRoute(c.req.method, c.req.path)) requireResourceAuthorization();
    await next();
  });
}
