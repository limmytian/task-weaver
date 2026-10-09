import { ZodError } from "zod";
import type { Database } from "@task-weaver/db";
import {
  AuthenticationError,
  AuthenticationRateLimitError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  ChatConfigurationError,
} from "@task-weaver/contracts";
import {
  createAuthenticationService,
  type AuthenticationConfiguration,
} from "./authentication";
import { createIdentityManagementService } from "./identity-management";
import { getLiveRequestAuthority } from "./api-keys";
export { requireLivePermission, requireRecentSession } from "./auth-security";

/** Hono and Next share configuration, provider state and live authorization; no header identity. */
export function authenticationConfiguration(
  env: Record<string, string | undefined>,
): AuthenticationConfiguration {
  if (!env.TW_AUTH_SECRET || !env.TW_AUTH_BASE_URL)
    throw new Error("TW_AUTH_SECRET and TW_AUTH_BASE_URL are required");
  const seconds = (name: string) =>
    env[name] === undefined ? undefined : Number(env[name]);
  return {
    secret: env.TW_AUTH_SECRET,
    baseURL: env.TW_AUTH_BASE_URL,
    bootstrapSecret: env.TW_AUTH_BOOTSTRAP_SECRET,
    trustedOrigins: env.TW_AUTH_TRUSTED_ORIGINS?.split(",").map((value) =>
      value.trim(),
    ) ?? [new URL(env.TW_AUTH_BASE_URL).origin],
    sessionDurationSeconds: seconds("TW_AUTH_SESSION_SECONDS"),
    sessionIdleSeconds: seconds("TW_AUTH_SESSION_IDLE_SECONDS"),
    maximumSessionDurationSeconds: seconds("TW_AUTH_MAX_SESSION_SECONDS"),
    activationDurationSeconds: seconds("TW_AUTH_ACTIVATION_SECONDS"),
  };
}

export function createAuthenticationRuntime(
  db: Database,
  configuration: AuthenticationConfiguration,
) {
  const authentication = createAuthenticationService(db, configuration);
  const identity = createIdentityManagementService(db, authentication);
  return {
    authentication,
    identity,
    trustedOrigins: new Set(configuration.trustedOrigins),
    assertOrigin(headers: Headers) {
      const origin = headers.get("origin");
      if (origin !== null && !configuration.trustedOrigins.includes(origin))
        throw new AuthorizationError("csrf_rejected");
    },
    async verify(headers: Headers) {
      const context = await authentication.resolve(headers);
      await getLiveRequestAuthority(db, context);
      return context;
    },
  };
}
export type AuthenticationRuntime = ReturnType<
  typeof createAuthenticationRuntime
>;

/** Until B/C authorization is implemented, legacy data and execution entry points stay closed. */
export function requireResourceAuthorization(): never {
  throw new AuthorizationError();
}

/** Unexpected errors can carry SQL parameters, passwords or provider tokens. */
export function authenticationFailure(error: unknown) {
  if (error instanceof ChatConfigurationError) return { status: 400 as const, error: error.message, code: error.code };
  if (error instanceof AuthenticationError)
    return { status: 401 as const, error: error.message, code: error.code };
  if (error instanceof AuthorizationError)
    return { status: 403 as const, error: error.message, code: error.code };
  if (error instanceof AuthenticationRateLimitError)
    return {
      status: 429 as const,
      error: error.message,
      code: "rate_limited",
      retryAfterSeconds: error.retryAfterSeconds,
    };
  if (
    error instanceof ZodError ||
    error instanceof ValidationError ||
    error instanceof SyntaxError
  )
    return {
      status: 400 as const,
      error: "Invalid request",
      code: "validation_failed",
    };
  if (error instanceof NotFoundError)
    return {
      status: 404 as const,
      error: "Resource not found",
      code: "not_found",
    };
  if (error instanceof ConflictError)
    return {
      status: 409 as const,
      error: "Operation conflicts with current state",
      code: "conflict",
    };
  return {
    status: 503 as const,
    error: "Authentication operation unavailable",
    code: "unavailable",
  };
}

/** Never serialize a Headers object or collapse multiple Set-Cookie values. */
export function takeAuthenticationResult<T>(
  result: T,
  output: Headers,
): Omit<T, "headers"> {
  if (
    result &&
    typeof result === "object" &&
    "headers" in result &&
    result.headers instanceof Headers
  ) {
    for (const [name, value] of result.headers)
      if (name !== "set-cookie") output.set(name, value);
    for (const cookie of result.headers.getSetCookie())
      output.append("set-cookie", cookie);
    const { headers: _, ...body } = result;
    return body as Omit<T, "headers">;
  }
  return result as Omit<T, "headers">;
}
