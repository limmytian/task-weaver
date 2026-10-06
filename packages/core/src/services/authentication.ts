import { authenticateExecutionDelegation } from './execution-delegations';
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  type Database,
  authAccounts,
  authActivations,
  authActors,
  authSessions,
  authUsers,
  authInstanceState,
  projectMemberships,
  apiKeys,
  apiKeyEvents,
  betterAuthTables,
} from "@task-weaver/db";
import {
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  accountDtoSchema,
  accountLoginSchema,
  bootstrapAccountSchema,
  activateAccountSchema,
  provisionAccountSchema,
  changeAccountPasswordSchema,
  reauthenticateAccountSchema,
  changeAccountStateSchema,
  sessionDtoSchema,
  requestIdentitySnapshotSchema,
  type VerifiedRequestContext,
} from "@task-weaver/contracts";
import { type AuthDatabase, loadActivePrincipal } from "./auth-principals";
import { authenticateScopedApiKey, getLiveRequestAuthority } from "./api-keys";
import {
  auditIdentity,
  guardAuthenticationOperations,
  constantTimeEqual,
  createCsrfPolicy,
  digest,
  limitAuthentication,
  lockIdentityLifecycle,
  readCookies,
  requireLivePermission,
  requireRecentSession,
} from "./auth-security";

const configurationSchema = z
  .object({
    secret: z.string().min(32).max(1024),
    bootstrapSecret: z.string().min(32).max(1024).optional(),
    baseURL: z.string().url(),
    trustedOrigins: z.array(z.string().url()).min(1).max(20),
    sessionDurationSeconds: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(604800),
    sessionIdleSeconds: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(86400),
    maximumSessionDurationSeconds: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(31_536_000),
    activationDurationSeconds: z
      .number()
      .int()
      .positive()
      .max(604800)
      .default(86400),
  })
  .strict();
export type AuthenticationConfiguration = z.input<typeof configurationSchema>;
const publicAccount = (user: typeof authUsers.$inferSelect) =>
  accountDtoSchema.parse({
    id: user.id,
    actorId: user.actorId,
    email: user.email,
    displayName: user.name,
    status: user.status,
    instanceRole: user.instanceRole,
    createdAt: user.createdAt.toISOString(),
  });
const safeSession = (
  session: typeof authSessions.$inferSelect,
  actorId: string,
) =>
  sessionDtoSchema.parse({
    id: session.id,
    actorId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.absoluteExpiresAt.toISOString(),
    lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
    revokedAt: session.revokedAt?.toISOString() ?? null,
  });

/** Security resets invalidate outstanding activation authority as subject and as issuer. */
async function revokePendingActivations(
  db: AuthDatabase,
  userId: string,
  byActorId: string,
  now: Date,
  issuedOnly = false,
) {
  const revoked = await db
    .update(authActivations)
    .set({ revokedAt: now })
    .where(
      and(
        issuedOnly
          ? eq(authActivations.issuedByUserId, userId)
          : or(
              eq(authActivations.userId, userId),
              eq(authActivations.issuedByUserId, userId),
            ),
        isNull(authActivations.consumedAt),
        isNull(authActivations.revokedAt),
      ),
    )
    .returning({ id: authActivations.id });
  if (revoked.length)
    await auditIdentity(
      db,
      "activation.links_revoked",
      byActorId,
      null,
      userId,
      { count: revoked.length, issuedOnly },
    );
}

/** Serialize account state with membership/owner changes. Revocation never erases credential history. */
export async function revokeAccountCredentials(
  db: AuthDatabase,
  userId: string,
  actorId: string,
  byActorId: string,
  now: Date,
) {
  await revokePendingActivations(db, userId, byActorId, now);
  await db
    .update(authSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
    );
  const managed = await db
    .select({ id: authActors.id })
    .from(authActors)
    .where(eq(authActors.managedByActorId, actorId));
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: now, revokedByActorId: byActorId })
    .where(
      and(
        inArray(apiKeys.actorId, [
          actorId,
          ...managed.map((actor) => actor.id),
        ]),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  if (revoked.length)
    await db.insert(apiKeyEvents).values(
      revoked.map((key) => ({
        action: "revoked" as const,
        keyId: key.id,
        actorId: byActorId,
        createdAt: now,
      })),
    );
}

/** Last-owner protection counts only persisted, active human accounts and actors. */
export async function assertOtherActiveOwner(
  db: AuthDatabase,
  projectId: string,
  excludedActorId: string,
) {
  const owners = await db
    .select({ id: authActors.id })
    .from(projectMemberships)
    .innerJoin(authActors, eq(authActors.id, projectMemberships.actorId))
    .innerJoin(authUsers, eq(authUsers.actorId, authActors.id))
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.role, "owner"),
        isNull(projectMemberships.removedAt),
        eq(authActors.status, "active"),
        eq(authUsers.status, "active"),
      ),
    );
  if (!owners.some((owner) => owner.id !== excludedActorId))
    throw new ValidationError("An active human project owner is required");
}

/** Provider endpoints are deliberately private. A4 exposes only these policy-enforced operations. */
export function createAuthenticationService(
  db: Database,
  configuration: AuthenticationConfiguration,
) {
  const config = configurationSchema.parse(configuration);
  const base = new URL(config.baseURL);
  if (
    base.origin !== config.baseURL ||
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new ValidationError(
      "Authentication requires an explicit HTTPS origin or loopback development origin",
    );
  for (const origin of config.trustedOrigins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new ValidationError(
        "Trusted origins must be exact HTTPS or loopback origins",
      );
  }
  if (
    config.sessionDurationSeconds > config.maximumSessionDurationSeconds ||
    config.sessionIdleSeconds > config.maximumSessionDurationSeconds
  )
    throw new ValidationError("Session defaults exceed the configured maximum");
  const secure = base.protocol === "https:";
  const sessionCookie = `${secure ? "__Secure-" : ""}tw.session_token`;
  const csrf = createCsrfPolicy(config.secret, config.trustedOrigins, secure);
  const loginTransaction = new AsyncLocalStorage<AuthDatabase>();
  // The provider and its hooks must share the held transaction, even when the pool has one connection.
  const providerDatabase = new Proxy(db, {
    get(target, property) {
      const current = loginTransaction.getStore() ?? target;
      const value = Reflect.get(current, property, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  const requestedDuration = new AsyncLocalStorage<{
    duration: number;
    idle: number;
  }>();
  const provider = betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(providerDatabase, {
      provider: "pg",
      schema: betterAuthTables,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: config.sessionDurationSeconds,
      freshAge: 900,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        absoluteExpiresAt: {
          type: "date",
          required: true,
          input: false,
          returned: false,
        },
        idleExpiresAt: {
          type: "date",
          required: true,
          input: false,
          returned: false,
        },
        idleTimeoutSeconds: {
          type: "number",
          required: true,
          input: false,
          returned: false,
        },
        authenticatedAt: {
          type: "date",
          required: true,
          input: false,
          returned: false,
        },
      },
    },
    user: {
      additionalFields: {
        actorId: {
          type: "string",
          required: true,
          input: false,
          returned: false,
        },
        actorType: {
          type: "string",
          required: true,
          input: false,
          returned: false,
        },
        status: {
          type: "string",
          required: true,
          input: false,
          returned: false,
        },
        instanceRole: {
          type: "string",
          required: true,
          input: false,
          returned: false,
        },
      },
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: "tw",
      database: { generateId: "uuid" },
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    databaseHooks: {
      user: { create: { before: async () => false } },
      session: {
        create: {
          before: async (session) => {
            const [user] = await providerDatabase
              .select()
              .from(authUsers)
              .where(eq(authUsers.id, session.userId));
            if (
              !user ||
              !(await loadActivePrincipal(providerDatabase, user.actorId))
            )
              return false;
            const createdAt = session.createdAt;
            const duration =
              requestedDuration.getStore()?.duration ??
              config.sessionDurationSeconds;
            const absolute = new Date(createdAt.getTime() + duration * 1000);
            const idleTimeoutSeconds = Math.min(
              requestedDuration.getStore()?.idle ?? config.sessionIdleSeconds,
              duration,
            );
            return {
              data: {
                ...session,
                expiresAt: absolute,
                absoluteExpiresAt: absolute,
                idleExpiresAt: new Date(
                  createdAt.getTime() + idleTimeoutSeconds * 1000,
                ),
                idleTimeoutSeconds,
                authenticatedAt: createdAt,
              },
            };
          },
        },
        // Better Auth otherwise physically removes expired sessions. Keep TW tombstones instead.
        delete: {
          before: async (session) => {
            await providerDatabase
              .update(authSessions)
              .set({ revokedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(authSessions.id, session.id),
                  isNull(authSessions.revokedAt),
                ),
              );
            return false;
          },
        },
      },
    },
  });
  const noStore = (): Headers => new Headers({ "cache-control": "no-store" });
  const clearCookie = (): Headers =>
    new Headers({
      "cache-control": "no-store",
      "set-cookie": `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
    });
  const mutations = (headers: Headers) => {
    if (!headers.has("authorization")) csrf.assert(headers);
  };
  async function anonymousAttempts(
    headers: Headers,
    purpose: string,
    identifier: string,
    clientAddress: string,
  ) {
    csrf.assert(headers);
    if (!clientAddress || clientAddress.length > 255)
      throw new ValidationError("A trusted client address is required");
    await limitAuthentication(db, `${purpose}:address`, clientAddress, 30);
    await limitAuthentication(db, `${purpose}:identity`, identifier, 10);
  }
  async function resolve(headers: Headers): Promise<VerifiedRequestContext> {
    const cookies = readCookies(headers);
    const hasCookie =
      cookies.has("tw.session_token") ||
      cookies.has("__Secure-tw.session_token");
    if (headers.has("authorization")) {
      const match = /^Bearer ((?:tw_|twd_)[0-9a-f]{64})$/.exec(
        headers.get("authorization") ?? "",
      );
      if (!match || hasCookie)
        throw new AuthenticationError("invalid_credential");
      return match[1]!.startsWith("twd_") ? authenticateExecutionDelegation(db, match[1]!) : authenticateScopedApiKey(db, match[1]!);
    }
    if (
      !cookies.has(sessionCookie) ||
      (cookies.has("tw.session_token") &&
        cookies.has("__Secure-tw.session_token"))
    )
      throw new AuthenticationError();
    const result = await provider.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) throw new AuthenticationError("invalid_credential");
    const now = new Date();
    const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, result.session.id));
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, result.user.id));
    if (!session || !user || session.userId !== user.id)
      throw new AuthenticationError("invalid_credential");
    if (session.revokedAt) throw new AuthenticationError("credential_revoked");
    if (
      [
        session.expiresAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
      ].some((expiry) => expiry <= now)
    ) {
      await db
        .update(authSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(authSessions.id, session.id), isNull(authSessions.revokedAt)),
        );
      throw new AuthenticationError("credential_expired");
    }
    const actor = await loadActivePrincipal(db, user.actorId);
    const touched = await db
      .update(authSessions)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        idleExpiresAt: new Date(
          Math.min(
            session.absoluteExpiresAt.getTime(),
            now.getTime() + session.idleTimeoutSeconds * 1000,
          ),
        ),
      })
      .where(
        and(
          eq(authSessions.id, session.id),
          isNull(authSessions.revokedAt),
          gt(authSessions.idleExpiresAt, now),
          gt(authSessions.absoluteExpiresAt, now),
        ),
      )
      .returning({ id: authSessions.id });
    if (!touched.length) throw new AuthenticationError("credential_revoked");
    return requestIdentitySnapshotSchema.parse({
      actor,
      credential: {
        kind: "session",
        id: session.id,
        actorId: actor.id,
        expiresAt: session.absoluteExpiresAt.toISOString(),
      },
      verifiedAt: now.toISOString(),
    }) as VerifiedRequestContext;
  }
  async function admin(dbOrTx: AuthDatabase, context: VerifiedRequestContext) {
    await requireRecentSession(dbOrTx, context);
    return (
      await requireLivePermission(dbOrTx, context, {
        scope: "instance",
        permissions: ["instance.manage"],
      })
    ).actor;
  }
  async function passwordMatches(
    dbOrTx: AuthDatabase,
    userId: string,
    password: string,
  ) {
    const [account] = await dbOrTx
      .select({ password: authAccounts.password })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, userId),
          eq(authAccounts.providerId, "credential"),
        ),
      );
    if (
      !account?.password ||
      !(await verifyPassword({ hash: account.password, password }))
    )
      throw new AuthenticationError("invalid_credential");
  }
  async function assertOtherAdministrator(
    dbOrTx: AuthDatabase,
    userId: string,
  ) {
    const rows = await dbOrTx
      .select({ id: authUsers.id })
      .from(authUsers)
      .innerJoin(authActors, eq(authUsers.actorId, authActors.id))
      .where(
        and(
          eq(authUsers.status, "active"),
          eq(authActors.status, "active"),
          eq(authUsers.instanceRole, "admin"),
        ),
      );
    if (!rows.some((row) => row.id !== userId))
      throw new ValidationError(
        "An active human instance administrator is required",
      );
  }
  return guardAuthenticationOperations({
    csrfChallenge: (headers?: Headers) =>
      headers ? csrf.challengeForRequest(headers) : csrf.challenge(),
    assertMutation: mutations,
    resolve,
    async bootstrap(headers: Headers, input: unknown, clientAddress: string) {
      await anonymousAttempts(headers, "bootstrap", "instance", clientAddress);
      const parsed = bootstrapAccountSchema.parse(input);
      if (
        !config.bootstrapSecret ||
        !constantTimeEqual(parsed.bootstrapSecret, config.bootstrapSecret)
      )
        throw new AuthenticationError("invalid_credential");
      const password = await hashPassword(parsed.password);
      return db.transaction(async (tx) => {
        const state = await lockIdentityLifecycle(tx);
        if (state.initializedByUserId)
          throw new ValidationError("Authentication is already initialized");
        const [actor] = await tx
          .insert(authActors)
          .values({
            type: "human",
            status: "active",
            displayName: parsed.displayName,
          })
          .returning();
        const [user] = await tx
          .insert(authUsers)
          .values({
            actorId: actor!.id,
            name: parsed.displayName,
            email: parsed.email,
            status: "active",
            instanceRole: "admin",
            emailVerified: true,
          })
          .returning();
        await tx.insert(authAccounts).values({
          userId: user!.id,
          accountId: user!.id,
          providerId: "credential",
          password,
        });
        await tx
          .update(authInstanceState)
          .set({ initializedByUserId: user!.id, initializedAt: new Date() })
          .where(eq(authInstanceState.id, "instance"));
        await auditIdentity(tx, "instance.bootstrapped", actor!.id);
        return { account: publicAccount(user!), headers: noStore() };
      });
    },
    async login(headers: Headers, input: unknown, clientAddress: string) {
      const parsed = accountLoginSchema.parse(input);
      await anonymousAttempts(
        headers,
        "login",
        parsed.email.toLowerCase(),
        clientAddress,
      );
      const duration =
        parsed.sessionDurationSeconds ?? config.sessionDurationSeconds;
      if (duration > config.maximumSessionDurationSeconds)
        throw new ValidationError("Session duration exceeds configured policy");
      const idle =
        parsed.sessionIdleSeconds ??
        Math.min(config.sessionIdleSeconds, duration);
      if (idle > duration || idle > config.maximumSessionDurationSeconds)
        throw new ValidationError("Idle lifetime exceeds session policy");
      try {
        return await db.transaction(async (tx) => {
          await lockIdentityLifecycle(tx);
          const result = await loginTransaction.run(tx, () =>
            requestedDuration.run({ duration, idle }, () =>
              provider.api.signInEmail({
                headers,
                body: {
                  email: parsed.email.toLowerCase(),
                  password: parsed.password,
                  rememberMe: true,
                },
                returnHeaders: true,
              }),
            ),
          );
          const [user] = await tx
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, result.response.user.id));
          if (!user) throw new AuthenticationError("invalid_credential");
          const [session] = await tx
            .select()
            .from(authSessions)
            .where(eq(authSessions.token, result.response.token!));
          if (!session) throw new AuthenticationError("invalid_credential");
          await getLiveRequestAuthority(
            tx,
            requestIdentitySnapshotSchema.parse({
              actor: await loadActivePrincipal(tx, user.actorId),
              credential: {
                kind: "session",
                id: session.id,
                actorId: user.actorId,
                expiresAt: session.absoluteExpiresAt.toISOString(),
              },
              verifiedAt: new Date().toISOString(),
            }) as VerifiedRequestContext,
          );
          const responseHeaders: Headers = noStore();
          for (const cookie of result.headers.getSetCookie())
            responseHeaders.append(
              "set-cookie",
              cookie.startsWith(`${sessionCookie}=`)
                ? cookie.replace(/Max-Age=\d+/i, `Max-Age=${duration}`)
                : cookie,
            );
          await auditIdentity(
            tx,
            "session.created",
            user.actorId,
            user.actorId,
            session.id,
          );
          return {
            account: publicAccount(user),
            session: safeSession(session, user.actorId),
            headers: responseHeaders,
          };
        });
      } catch (error) {
        await auditIdentity(db, "session.login_rejected", null);
        if (error instanceof AuthenticationError) throw error;
        // Provider errors can contain account fields; never forward them across the adapter boundary.
        throw new AuthenticationError("invalid_credential");
      }
    },
    async current(headers: Headers) {
      const context = await resolve(headers);
      if (context.actor.type !== "human")
        return { actor: context.actor, account: null, session: null };
      const [user] = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, context.actor.userId));
      const [session] =
        context.credential.kind === "session"
          ? await db
              .select()
              .from(authSessions)
              .where(eq(authSessions.id, context.credential.id))
          : [];
      return {
        actor: context.actor,
        account: publicAccount(user!),
        session: session ? safeSession(session, context.actor.id) : null,
      };
    },
    async logout(headers: Headers) {
      mutations(headers);
      const context = await resolve(headers);
      if (context.credential.kind !== "session") throw new AuthorizationError();
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.id, context.credential.id));
      await auditIdentity(
        db,
        "session.revoked",
        context.actor.id,
        context.actor.id,
        context.credential.id,
      );
      return { headers: clearCookie() };
    },
    async reauthenticate(
      headers: Headers,
      input: unknown,
      clientAddress: string,
    ) {
      const parsed = reauthenticateAccountSchema.parse(input);
      const context = await resolve(headers);
      csrf.assert(headers);
      if (
        context.actor.type !== "human" ||
        context.credential.kind !== "session"
      )
        throw new AuthorizationError();
      await limitAuthentication(db, "reauthenticate", context.actor.id, 10);
      await limitAuthentication(
        db,
        "reauthenticate:address",
        clientAddress,
        30,
      );
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await getLiveRequestAuthority(tx, context);
        await passwordMatches(
          tx,
          context.actor.type === "human" ? context.actor.userId : "",
          parsed.password,
        );
        await tx
          .update(authSessions)
          .set({ authenticatedAt: new Date() })
          .where(eq(authSessions.id, context.credential.id));
        await auditIdentity(
          tx,
          "session.reauthenticated",
          context.actor.id,
          context.actor.id,
          context.credential.id,
        );
      });
    },
    async changePassword(
      headers: Headers,
      input: unknown,
      clientAddress: string,
    ) {
      const parsed = changeAccountPasswordSchema.parse(input);
      csrf.assert(headers);
      const context = await resolve(headers);
      if (context.actor.type !== "human") throw new AuthorizationError();
      await requireRecentSession(db, context);
      await limitAuthentication(db, "password-change", context.actor.id, 10);
      await limitAuthentication(
        db,
        "password-change:address",
        clientAddress,
        30,
      );
      const password = await hashPassword(parsed.newPassword);
      const userId = context.actor.userId;
      await db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await requireRecentSession(tx, context);
        await passwordMatches(tx, userId, parsed.currentPassword);
        await tx
          .update(authAccounts)
          .set({ password, updatedAt: new Date() })
          .where(eq(authAccounts.userId, userId));
        await revokeAccountCredentials(
          tx,
          userId,
          context.actor.id,
          context.actor.id,
          new Date(),
        );
        await auditIdentity(tx, "account.password_changed", context.actor.id);
      });
      return { headers: clearCookie() };
    },
    async provision(headers: Headers, input: unknown) {
      mutations(headers);
      const context = await resolve(headers);
      await admin(db, context);
      const parsed = provisionAccountSchema.parse(input);
      const token = randomBytes(32).toString("hex");
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const actor = await admin(tx, context);
        if (actor.type !== "human") throw new AuthorizationError();
        const exists = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, parsed.email));
        if (exists.length)
          throw new ValidationError("Account cannot be provisioned");
        const [subject] = await tx
          .insert(authActors)
          .values({ type: "human", displayName: parsed.displayName })
          .returning();
        const [user] = await tx
          .insert(authUsers)
          .values({
            actorId: subject!.id,
            name: parsed.displayName,
            email: parsed.email,
          })
          .returning();
        const expiresAt = new Date(
          Date.now() + config.activationDurationSeconds * 1000,
        );
        await tx.insert(authActivations).values({
          userId: user!.id,
          issuedByUserId: actor.userId,
          tokenHash: digest(token),
          purpose: "invite",
          expiresAt,
        });
        await auditIdentity(tx, "account.invited", actor.id, subject!.id);
        return {
          account: publicAccount(user!),
          activationToken: token,
          expiresAt: expiresAt.toISOString(),
          headers: noStore(),
        };
      });
    },
    async recover(headers: Headers, userId: string) {
      z.string().uuid().parse(userId);
      mutations(headers);
      const context = await resolve(headers);
      await admin(db, context);
      const token = randomBytes(32).toString("hex");
      const suspendedPassword = await hashPassword(
        randomBytes(32).toString("hex"),
      );
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const actor = await admin(tx, context);
        if (actor.type !== "human") throw new AuthorizationError();
        const [user] = await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, userId));
        if (!user) throw new ValidationError("Account cannot be recovered");
        const now = new Date();
        await tx
          .update(authActivations)
          .set({ revokedAt: now })
          .where(
            and(
              eq(authActivations.userId, userId),
              isNull(authActivations.revokedAt),
              isNull(authActivations.consumedAt),
            ),
          );
        await revokeAccountCredentials(tx, userId, user.actorId, actor.id, now);
        await tx
          .update(authAccounts)
          .set({ password: suspendedPassword, updatedAt: now })
          .where(eq(authAccounts.userId, userId));
        const expiresAt = new Date(
          now.getTime() + config.activationDurationSeconds * 1000,
        );
        await tx.insert(authActivations).values({
          userId,
          issuedByUserId: actor.userId,
          tokenHash: digest(token),
          purpose: "recovery",
          expiresAt,
        });
        await auditIdentity(
          tx,
          "account.recovery_issued",
          actor.id,
          user.actorId,
        );
        return {
          activationToken: token,
          expiresAt: expiresAt.toISOString(),
          headers: noStore(),
        };
      });
    },
    async activate(headers: Headers, input: unknown, clientAddress: string) {
      const parsed = activateAccountSchema.parse(input);
      await anonymousAttempts(
        headers,
        "activation",
        digest(parsed.token),
        clientAddress,
      );
      const password = await hashPassword(parsed.password);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const now = new Date();
        const [activation] = await tx
          .select()
          .from(authActivations)
          .where(
            and(
              eq(authActivations.tokenHash, digest(parsed.token)),
              isNull(authActivations.consumedAt),
              isNull(authActivations.revokedAt),
              gt(authActivations.expiresAt, now),
            ),
          );
        if (!activation) throw new AuthenticationError("invalid_credential");
        const [issuer] = await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, activation.issuedByUserId));
        if (!issuer || issuer.instanceRole !== "admin")
          throw new AuthenticationError("invalid_credential");
        await loadActivePrincipal(tx, issuer.actorId);
        const [user] = await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, activation.userId));
        if (!user) throw new AuthenticationError("invalid_credential");
        await tx
          .insert(authAccounts)
          .values({
            userId: user.id,
            accountId: user.id,
            providerId: "credential",
            password,
          })
          .onConflictDoUpdate({
            target: [authAccounts.userId, authAccounts.providerId],
            set: { password, updatedAt: now },
          });
        await tx
          .update(authActivations)
          .set({ consumedAt: now })
          .where(eq(authActivations.id, activation.id));
        await revokeAccountCredentials(
          tx,
          user.id,
          user.actorId,
          issuer.actorId,
          now,
        );
        await tx
          .update(authActors)
          .set({ status: "active", updatedAt: now })
          .where(eq(authActors.id, user.actorId));
        const [updated] = await tx
          .update(authUsers)
          .set({ status: "active", emailVerified: true, updatedAt: now })
          .where(eq(authUsers.id, user.id))
          .returning();
        await auditIdentity(
          tx,
          "account.activated",
          issuer.actorId,
          user.actorId,
          activation.id,
          { recovery: activation.purpose === "recovery" },
        );
        return { account: publicAccount(updated!), headers: noStore() };
      });
    },
    async listAccounts(headers: Headers) {
      const context = await resolve(headers);
      await requireLivePermission(db, context, {
        scope: "instance",
        permissions: ["instance.manage"],
      });
      return (await db.select().from(authUsers)).map(publicAccount);
    },
    async listSessions(headers: Headers) {
      const context = await resolve(headers);
      const authority = await getLiveRequestAuthority(db, context);
      if (authority.actor.type !== "human") throw new AuthorizationError();
      await requireLivePermission(db, context, {
        scope: "personal",
        actorId: authority.actor.id,
        permissions: ["credential.manage"],
      });
      const actorId = authority.actor.id;
      return (
        await db
          .select()
          .from(authSessions)
          .where(eq(authSessions.userId, authority.actor.userId))
      ).map((session) => safeSession(session, actorId));
    },
    async revokeSession(headers: Headers, sessionId: string) {
      z.string().uuid().parse(sessionId);
      mutations(headers);
      const context = await resolve(headers);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        await requireRecentSession(tx, context);
        const authority = await getLiveRequestAuthority(tx, context);
        if (authority.actor.type !== "human") throw new AuthorizationError();
        await requireLivePermission(tx, context, {
          scope: "personal",
          actorId: authority.actor.id,
          permissions: ["credential.manage"],
        });
        const [session] = await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(authSessions.id, sessionId),
              eq(authSessions.userId, authority.actor.userId),
            ),
          )
          .returning();
        if (!session) throw new ValidationError("Session cannot be revoked");
        await auditIdentity(
          tx,
          "session.revoked",
          authority.actor.id,
          authority.actor.id,
          session.id,
        );
        return safeSession(session, authority.actor.id);
      });
    },
    async setAccountState(headers: Headers, userId: string, input: unknown) {
      z.string().uuid().parse(userId);
      const parsed = changeAccountStateSchema.parse(input);
      mutations(headers);
      const context = await resolve(headers);
      await admin(db, context);
      return db.transaction(async (tx) => {
        await lockIdentityLifecycle(tx);
        const actor = await admin(tx, context);
        const [user] = await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, userId));
        if (!user) throw new ValidationError("Account cannot be changed");
        if (
          user.status === "active" &&
          user.instanceRole === "admin" &&
          (parsed.status === "disabled" || parsed.instanceRole === "user")
        )
          await assertOtherAdministrator(tx, userId);
        if (parsed.status === "disabled") {
          const memberships = await tx
            .select({ projectId: projectMemberships.projectId })
            .from(projectMemberships)
            .where(
              and(
                eq(projectMemberships.actorId, user.actorId),
                eq(projectMemberships.role, "owner"),
                isNull(projectMemberships.removedAt),
              ),
            );
          for (const membership of memberships)
            await assertOtherActiveOwner(
              tx,
              membership.projectId,
              user.actorId,
            );
          await tx
            .update(authActors)
            .set({ status: "disabled", updatedAt: new Date() })
            .where(eq(authActors.id, user.actorId));
          await revokeAccountCredentials(
            tx,
            userId,
            user.actorId,
            actor.id,
            new Date(),
          );
          await tx
            .update(authActivations)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(authActivations.userId, userId),
                isNull(authActivations.consumedAt),
                isNull(authActivations.revokedAt),
              ),
            );
        }
        if (user.instanceRole === "admin" && parsed.instanceRole === "user") {
          await revokePendingActivations(
            tx,
            userId,
            actor.id,
            new Date(),
            true,
          );
        }
        const [updated] = await tx
          .update(authUsers)
          .set({ ...parsed, updatedAt: new Date() })
          .where(eq(authUsers.id, userId))
          .returning();
        await auditIdentity(
          tx,
          "account.state_changed",
          actor.id,
          user.actorId,
          userId,
          {
            disabled: parsed.status === "disabled",
            role: parsed.instanceRole ?? user.instanceRole,
          },
        );
        return publicAccount(updated!);
      });
    },
  });
}
