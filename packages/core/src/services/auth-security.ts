import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ZodError } from "zod";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  authAuditEvents,
  authInstanceState,
  authRateLimits,
  authSessions,
} from "@task-weaver/db";
import {
  AuthenticationRateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  AuthorizationError,
  type AuthorizationGrant,
  type VerifiedRequestContext,
} from "@task-weaver/contracts";
import { type AuthDatabase, grantsAreCovered } from "./auth-principals";
import { getLiveRequestAuthority } from "./api-keys";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function constantTimeEqual(left: string, right: string) {
  return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}

export async function lockIdentityLifecycle(db: AuthDatabase) {
  const [state] = await db
    .select()
    .from(authInstanceState)
    .where(eq(authInstanceState.id, "instance"))
    .for("update");
  if (!state) throw new Error("Authentication migrations are required");
  return state;
}

export async function auditIdentity(
  db: AuthDatabase,
  action: string,
  actorId: string | null,
  subjectActorId: string | null = actorId,
  entityId: string | null = null,
  metadata: Record<string, string | number | boolean> = {},
) {
  await db
    .insert(authAuditEvents)
    .values({ action, actorId, subjectActorId, entityId, metadata });
}

/** Use only a trusted adapter's direct client address, never caller-supplied proxy headers. */
export async function limitAuthentication(
  db: AuthDatabase,
  purpose: string,
  identifier: string,
  maximum: number,
  now = new Date(),
) {
  const windowSeconds = 900;
  const start = new Date(now.getTime() - windowSeconds * 1000);
  const [counter] = await db
    .insert(authRateLimits)
    .values({
      id: `${purpose}:${digest(identifier)}`,
      count: 1,
      windowStartedAt: now,
    })
    .onConflictDoUpdate({
      target: authRateLimits.id,
      set: {
        count: sql`CASE WHEN ${authRateLimits.windowStartedAt} <= ${start.toISOString()}::timestamptz THEN 1 ELSE ${authRateLimits.count} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${authRateLimits.windowStartedAt} <= ${start.toISOString()}::timestamptz THEN ${now.toISOString()}::timestamptz ELSE ${authRateLimits.windowStartedAt} END`,
      },
    })
    .returning();
  if (counter!.count > maximum)
    throw new AuthenticationRateLimitError(
      Math.max(
        1,
        Math.ceil(
          (counter!.windowStartedAt.getTime() +
            windowSeconds * 1000 -
            now.getTime()) /
            1000,
        ),
      ),
    );
  // Bound retention without deleting an active window.
  await db
    .delete(authRateLimits)
    .where(
      lt(authRateLimits.windowStartedAt, new Date(now.getTime() - 86_400_000)),
    );
}

export async function requireLivePermission(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  grant: AuthorizationGrant,
  now = new Date(),
) {
  const authority = await getLiveRequestAuthority(db, context, now);
  if (!grantsAreCovered([grant], authority.grants))
    throw new AuthorizationError();
  return authority;
}

export async function requireRecentSession(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  now = new Date(),
) {
  await getLiveRequestAuthority(db, context, now);
  if (context.credential.kind !== "session") throw new AuthorizationError();
  const [session] = await db
    .select({ authenticatedAt: authSessions.authenticatedAt })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, context.credential.id),
        isNull(authSessions.revokedAt),
      ),
    );
  if (
    !session ||
    session.authenticatedAt > now ||
    now.getTime() - session.authenticatedAt.getTime() > 900_000
  )
    throw new AuthorizationError();
}

export function readCookies(headers: Headers) {
  const result = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (result.has(name)) throw new AuthorizationError("csrf_rejected");
    result.set(name, part.slice(index + 1).trim());
  }
  return result;
}

/** Signed double-submit challenge also protects anonymous login/bootstrap/activation. */
export function createCsrfPolicy(
  secret: string,
  origins: readonly string[],
  secure: boolean,
) {
  const cookieName = secure ? "__Host-tw.csrf" : "tw.csrf";
  const sign = (value: string) =>
    createHmac("sha256", secret).update(`tw.csrf:${value}`).digest("hex");
  return {
    challenge(now = new Date()): { csrfToken: string; headers: Headers } {
      const payload = `${now.getTime()}.${randomBytes(32).toString("hex")}`;
      const token = `${payload}.${sign(payload)}`;
      return {
        csrfToken: token,
        headers: new Headers({
          "set-cookie": `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
        }),
      };
    },
    assert(headers: Headers, now = new Date()) {
      const origin = headers.get("origin");
      if (!origin || !origins.includes(origin))
        throw new AuthorizationError("csrf_rejected");
      const token = headers.get("x-csrf-token") ?? "";
      const match = /^(\d{13})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(token);
      if (
        !match ||
        !constantTimeEqual(readCookies(headers).get(cookieName) ?? "", token)
      )
        throw new AuthorizationError("csrf_rejected");
      const issuedAt = Number(match[1]);
      if (
        issuedAt > now.getTime() ||
        now.getTime() - issuedAt > 3_600_000 ||
        !constantTimeEqual(match[3]!, sign(`${match[1]}.${match[2]}`))
      )
        throw new AuthorizationError("csrf_rejected");
    },
  };
}

/** Database/provider exceptions may embed query parameters. Keep them inside the service boundary. */
export function guardAuthenticationOperations<T extends object>(
  operations: T,
): T {
  const reject = (error: unknown): never => {
    if (
      error instanceof AuthenticationError ||
      error instanceof AuthorizationError ||
      error instanceof AuthenticationRateLimitError ||
      error instanceof NotFoundError ||
      error instanceof ValidationError ||
      error instanceof ZodError
    )
      throw error;
    throw new Error("Authentication operation unavailable");
  };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== "function") continue;
    const call = operation as (...args: unknown[]) => unknown;
    Object.defineProperty(operations, name, {
      enumerable: true,
      value: (...args: unknown[]) => {
        try {
          const result = call.apply(operations, args);
          return result instanceof Promise ? result.catch(reject) : result;
        } catch (error) {
          return reject(error);
        }
      },
    });
  }
  return operations;
}
