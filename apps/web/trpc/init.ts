import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { createDb, type Database } from "@task-weaver/db";
import {
  authenticationConfiguration,
  createAuthenticationRuntime,
  authenticationFailure,
  requireResourceAuthorization,
  requireRecentSession,
  requireLivePermission,
  type AuthenticationRuntime,
} from "@task-weaver/core";
import type { VerifiedRequestContext } from "@task-weaver/contracts";

export type TRPCContext = {
  db: Database;
  auth: AuthenticationRuntime;
  req: Request;
  responseHeaders: Headers;
};
export interface TRPCRequestContextOptions {
  req: Request;
  resHeaders?: Headers;
}
export interface TRPCContextDependencies {
  db: Database;
  auth?: AuthenticationRuntime;
}
let server: TRPCContextDependencies | undefined;
export function getWebAuthenticationRuntime() {
  if (!server) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    const db = createDb(process.env.DATABASE_URL);
    server = {
      db,
      auth: createAuthenticationRuntime(
        db,
        authenticationConfiguration(process.env),
      ),
    };
  }
  return { db: server.db, auth: server.auth! };
}
export function createTRPCContextFactory(
  dependencies: TRPCContextDependencies,
) {
  return async ({
    req,
    resHeaders,
  }: TRPCRequestContextOptions): Promise<TRPCContext> => ({
    db: dependencies.db,
    auth:
      dependencies.auth ??
      createAuthenticationRuntime(
        dependencies.db,
        authenticationConfiguration(process.env),
      ),
    req,
    responseHeaders: resHeaders ?? new Headers(),
  });
}
export async function createTRPCContext(options: TRPCRequestContextOptions) {
  try {
    return await createTRPCContextFactory(getWebAuthenticationRuntime())(
      options,
    );
  } catch (error) {
    throw safeError(error).error;
  }
}
const statusCodes = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  503: "SERVICE_UNAVAILABLE",
} as const;
function safeError(error: unknown) {
  const cause = error instanceof TRPCError ? (error.cause ?? error) : error;
  const failure =
    error instanceof TRPCError &&
    ["BAD_REQUEST", "PARSE_ERROR"].includes(error.code)
      ? {
          status: 400 as const,
          error: "Invalid request",
          code: "validation_failed",
        }
      : authenticationFailure(cause);
  const causeForTransport = Object.assign(new Error(failure.error), {
    authCode: failure.code,
  });
  return {
    failure,
    error: new TRPCError({
      code: statusCodes[failure.status],
      message: failure.error,
      cause: causeForTransport,
    }),
  };
}
const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const data = { ...shape.data };
    delete data.stack;
    const authCode =
      error.cause && "authCode" in error.cause
        ? String(error.cause.authCode)
        : undefined;
    return {
      ...shape,
      message:
        shape.data.code === "BAD_REQUEST" && !authCode?.startsWith("chat_") ? "Invalid request" : shape.message,
      data: { ...data, authCode },
    };
  },
});
const safe = t.procedure.use(async ({ ctx, next }) => {
  ctx.responseHeaders.set("cache-control", "no-store");
  const result = await next();
  if (!result.ok) {
    const { failure, error } = safeError(result.error);
    if ("retryAfterSeconds" in failure)
      ctx.responseHeaders.set("retry-after", String(failure.retryAfterSeconds));
    return { ...result, error };
  }
  return result;
});
const publicPaths = new Map([
  ["version.info", "query"],
  ["auth.csrf", "query"],
  ["auth.setupStatus", "query"],
  ["auth.login", "mutation"],
  ["auth.bootstrap", "mutation"],
  ["auth.activate", "mutation"],
]);
export const publicProcedure = safe.use(async ({ ctx, path, type, next }) => {
  if (publicPaths.get(path) !== type) requireResourceAuthorization();
  ctx.auth.assertOrigin(ctx.req.headers);
  if (ctx.req.headers.has("authorization"))
    await ctx.auth.verify(ctx.req.headers);
  return next();
});
export const protectedProcedure = safe.use(async ({ ctx, type, next }) => {
  ctx.auth.assertOrigin(ctx.req.headers);
  const identity: VerifiedRequestContext = await ctx.auth.verify(
    ctx.req.headers,
  );
  if (type === "mutation" || !["GET", "HEAD"].includes(ctx.req.method))
    ctx.auth.authentication.assertMutation(ctx.req.headers);
  return next({
    ctx: {
      ...ctx,
      identity,
      actor: { id: identity.actor.id, type: identity.actor.type },
    },
  });
});
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await requireRecentSession(ctx.db, ctx.identity);
  await requireLivePermission(ctx.db, ctx.identity, {
    scope: "instance",
    permissions: ["instance.manage"],
  });
  return next();
});
export const ordinaryResourceProcedure = protectedProcedure;
export const resourceProcedure = protectedProcedure.use(() =>
  requireResourceAuthorization(),
);
export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
