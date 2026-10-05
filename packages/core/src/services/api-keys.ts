import { eq, and, gt, isNull, or } from "drizzle-orm";
import {
  type Database,
  apiKeys,
  apiKeyEvents,
  authSessions,
} from "@task-weaver/db";
import { createHash, randomBytes } from "node:crypto";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  apiKeyDtoSchema,
  credentialGrantsSchema,
  issueScopedApiKeySchema,
  requestIdentitySnapshotSchema,
  type IssueScopedApiKey,
  type VerifiedRequestContext,
} from "@task-weaver/contracts";
import {
  type AuthDatabase,
  grantsAreCovered,
  intersectGrants,
  loadActivePrincipal,
  loadPrincipalForManagement,
  loadPrincipalGrants,
} from "./auth-principals";

type StoredKey = typeof apiKeys.$inferSelect;
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
function generateApiKey() {
  const raw = `tw_${randomBytes(32).toString("hex")}`;
  return { raw, prefix: raw.slice(0, 10), hash: hashKey(raw) };
}
function publicKey(key: StoredKey) {
  return apiKeyDtoSchema.parse({
    id: key.id,
    actorId: key.actorId,
    issuedByActorId: key.issuedByActorId,
    name: key.name,
    prefix: key.keyPrefix,
    grants: key.grants,
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  });
}
function legacyPublicKey(key: StoredKey) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    permissions: key.permissions,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}

/** Also checks ancestors so revocation cannot be bypassed through a derived credential. */
async function liveKeyAuthority(
  db: AuthDatabase,
  key: StoredKey,
  now: Date,
  seen = new Set<string>(),
) {
  if (
    seen.has(key.id) ||
    seen.size >= 16 ||
    !key.actorId ||
    !key.issuedByActorId ||
    !key.grants
  )
    throw new AuthenticationError("invalid_credential");
  seen.add(key.id);
  if (key.revokedAt) throw new AuthenticationError("credential_revoked");
  if (key.expiresAt && key.expiresAt <= now)
    throw new AuthenticationError("credential_expired");
  const actor = await loadActivePrincipal(db, key.actorId);
  if (
    key.issuedByActorId !== actor.id &&
    (actor.type !== "agent" || actor.managedByActorId !== key.issuedByActorId)
  )
    throw new AuthenticationError("invalid_credential");
  let grants = intersectGrants(
    credentialGrantsSchema.parse(key.grants),
    await loadPrincipalGrants(db, actor.id),
  );
  if (key.parentKeyId) {
    const [parent] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, key.parentKeyId))
      .limit(1);
    if (
      !parent ||
      parent.actorId !== key.issuedByActorId ||
      (parent.expiresAt && (!key.expiresAt || key.expiresAt > parent.expiresAt))
    )
      throw new AuthenticationError("invalid_credential");
    const authority = await liveKeyAuthority(db, parent, now, seen);
    grants = intersectGrants(grants, authority.grants);
  }
  if (!grants.length) throw new AuthorizationError();
  return { actor, grants, depth: seen.size };
}

/** Trusted server entry point; unbound legacy keys can never produce verified identity. */
export async function authenticateScopedApiKey(
  db: AuthDatabase,
  rawKey: string,
): Promise<VerifiedRequestContext> {
  if (!/^tw_[0-9a-f]{64}$/.test(rawKey))
    throw new AuthenticationError("invalid_credential");
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashKey(rawKey)))
    .limit(1);
  if (!key) throw new AuthenticationError("invalid_credential");
  const now = new Date();
  const authority = await liveKeyAuthority(db, key, now);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(and(eq(apiKeys.id, key.id), isNull(apiKeys.revokedAt)));
  return requestIdentitySnapshotSchema.parse({
    actor: authority.actor,
    credential: {
      kind: "api_key",
      id: key.id,
      actorId: key.actorId,
      expiresAt: key.expiresAt?.toISOString() ?? null,
      grants: authority.grants,
    },
    verifiedAt: now.toISOString(),
  }) as VerifiedRequestContext;
}

/** Re-read the credential instead of trusting a stale context's role, grants or expiry. */
async function currentAuthority(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  now: Date,
) {
  const actor = await loadActivePrincipal(db, context.actor.id);
  if (context.credential.actorId !== actor.id)
    throw new AuthenticationError("invalid_credential");
  if (context.credential.kind === "api_key") {
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, context.credential.id))
      .limit(1);
    if (!key || key.actorId !== actor.id)
      throw new AuthenticationError("invalid_credential");
    return { ...(await liveKeyAuthority(db, key, now)), key };
  }
  if (context.credential.kind !== "session" || actor.type !== "human")
    throw new AuthorizationError();
  const [session] = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, context.credential.id))
    .limit(1);
  if (!session || session.userId !== actor.userId)
    throw new AuthenticationError("invalid_credential");
  if (session.revokedAt) throw new AuthenticationError("credential_revoked");
  if (
    [session.expiresAt, session.absoluteExpiresAt, session.idleExpiresAt].some(
      (expiry) => expiry <= now,
    )
  )
    throw new AuthenticationError("credential_expired");
  return {
    actor,
    grants: await loadPrincipalGrants(db, actor.id),
    key: null,
    depth: 0,
  };
}
async function credentialManager(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  actorId: string,
  now: Date,
  allowDisabledSubject = false,
) {
  const authority = await currentAuthority(db, context, now);
  if (authority.actor.type !== "human") throw new AuthorizationError();
  if (
    !grantsAreCovered(
      [
        {
          scope: "personal",
          actorId: authority.actor.id,
          permissions: ["credential.manage"],
        },
      ],
      authority.grants,
    )
  )
    throw new AuthorizationError();
  const subject = await (allowDisabledSubject
    ? loadPrincipalForManagement(db, actorId)
    : loadActivePrincipal(db, actorId));
  if (
    subject.id !== authority.actor.id &&
    (subject.type !== "agent" ||
      subject.managedByActorId !== authority.actor.id)
  )
    throw new AuthorizationError();
  return { ...authority, subject };
}
async function keyManager(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  actorId: string,
  now: Date,
  allowDisabledSubject = false,
) {
  try {
    return await credentialManager(
      db,
      context,
      actorId,
      now,
      allowDisabledSubject,
    );
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new NotFoundError("API key not found");
    throw error;
  }
}

function expiryDate(expiresAt: string | null, now: Date) {
  const expiry = expiresAt === null ? null : new Date(expiresAt);
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry <= now))
    throw new ValidationError("API key expiry must be in the future");
  return expiry;
}
function enforceParentExpiry(expiresAt: Date | null, parent: StoredKey | null) {
  if (parent?.expiresAt && (!expiresAt || expiresAt > parent.expiresAt))
    throw new AuthorizationError();
}

/** The subject parameter is a server-resolved self/managed-agent target, never a trusted body field. */
export async function issueScopedApiKey(
  db: Database,
  context: VerifiedRequestContext,
  actorId: string,
  input: IssueScopedApiKey,
) {
  const parsed = issueScopedApiKeySchema.parse(input);
  return db.transaction(
    async (tx) => {
      const now = new Date();
      const authority = await credentialManager(tx, context, actorId, now);
      if (
        !grantsAreCovered(parsed.grants, authority.grants) ||
        !grantsAreCovered(
          parsed.grants,
          await loadPrincipalGrants(tx, authority.subject.id),
        )
      )
        throw new AuthorizationError();
      const expiresAt = expiryDate(parsed.expiresAt, now);
      enforceParentExpiry(expiresAt, authority.key);
      if (authority.depth >= 16)
        throw new ValidationError("Maximum API key derivation depth exceeded");
      const material = generateApiKey();
      const [created] = await tx
        .insert(apiKeys)
        .values({
          name: parsed.name,
          actorId,
          issuedByActorId: authority.actor.id,
          grants: parsed.grants,
          parentKeyId: authority.key?.id,
          keyHash: material.hash,
          keyPrefix: material.prefix,
          expiresAt,
          createdAt: now,
        })
        .returning();
      await tx.insert(apiKeyEvents).values({
        keyId: created!.id,
        actorId: authority.actor.id,
        action: "issued",
      });
      return { ...publicKey(created!), rawKey: material.raw };
    },
    { isolationLevel: "serializable" },
  );
}

export async function listScopedApiKeys(
  db: Database,
  context: VerifiedRequestContext,
  actorId: string,
) {
  await credentialManager(db, context, actorId, new Date(), true);
  const keys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.actorId, actorId), isNull(apiKeys.revokedAt)))
    .orderBy(apiKeys.createdAt);
  return keys.map(publicKey);
}

export async function revokeScopedApiKey(
  db: Database,
  context: VerifiedRequestContext,
  id: string,
) {
  return db.transaction(
    async (tx) => {
      const [key] = await tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1)
        .for("update");
      if (!key?.actorId) throw new NotFoundError("API key not found");
      const authority = await keyManager(
        tx,
        context,
        key.actorId,
        new Date(),
        true,
      );
      if (key.revokedAt) return publicKey(key);
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedByActorId: authority.actor.id })
        .where(eq(apiKeys.id, id))
        .returning();
      await tx
        .insert(apiKeyEvents)
        .values({ keyId: id, actorId: authority.actor.id, action: "revoked" });
      return publicKey(revoked!);
    },
    { isolationLevel: "serializable" },
  );
}

export async function rotateScopedApiKey(
  db: Database,
  context: VerifiedRequestContext,
  id: string,
) {
  return db.transaction(
    async (tx) => {
      const now = new Date();
      const [key] = await tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1)
        .for("update");
      if (!key?.actorId) throw new NotFoundError("API key not found");
      const authority = await keyManager(tx, context, key.actorId, now);
      const live = await liveKeyAuthority(tx, key, now);
      const grants = intersectGrants(live.grants, authority.grants);
      if (!grants.length) throw new AuthorizationError();
      enforceParentExpiry(key.expiresAt, authority.key);
      if (
        authority.key &&
        authority.key.id !== key.id &&
        (authority.actor.id !== key.issuedByActorId ||
          (key.parentKeyId && key.parentKeyId !== authority.key.id))
      )
        throw new AuthorizationError();
      if (authority.key && authority.key.id !== key.id && authority.depth >= 16)
        throw new ValidationError("Maximum API key derivation depth exceeded");
      const material = generateApiKey();
      const [created] = await tx
        .insert(apiKeys)
        .values({
          name: key.name,
          actorId: key.actorId,
          issuedByActorId: key.issuedByActorId,
          grants,
          expiresAt: key.expiresAt,
          createdAt: now,
          parentKeyId:
            authority.key?.id === key.id
              ? key.parentKeyId
              : (key.parentKeyId ?? authority.key?.id),
          rotatedFromId: key.id,
          keyHash: material.hash,
          keyPrefix: material.prefix,
        })
        .returning();
      await tx
        .update(apiKeys)
        .set({ revokedAt: now, revokedByActorId: authority.actor.id })
        .where(eq(apiKeys.id, id));
      await tx.insert(apiKeyEvents).values([
        { keyId: id, actorId: authority.actor.id, action: "revoked" },
        {
          keyId: created!.id,
          actorId: authority.actor.id,
          action: "rotated",
          previousKeyId: id,
        },
      ]);
      return {
        ...publicKey(created!),
        rawKey: material.raw,
        previousKeyId: id,
      };
    },
    { isolationLevel: "serializable" },
  );
}

/** @deprecated Legacy transport compatibility only; never creates a bound credential. Retire in A4. */
export async function createApiKey(
  db: Database,
  input: {
    name: string;
    permissions?: Record<string, boolean>;
    expiresAt?: Date;
  },
) {
  const material = generateApiKey();
  const [key] = await db
    .insert(apiKeys)
    .values({
      name: input.name,
      permissions: input.permissions,
      expiresAt: input.expiresAt,
      keyHash: material.hash,
      keyPrefix: material.prefix,
    })
    .returning();
  return { ...legacyPublicKey(key!), rawKey: material.raw };
}
/** @deprecated Legacy middleware must not accept a scoped credential as an unrestricted legacy actor. */
export async function validateApiKey(db: Database, rawKey: string) {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, hashKey(rawKey)),
        isNull(apiKeys.actorId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!key) return null;
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, key.id), isNull(apiKeys.revokedAt)));
  return legacyPublicKey(key);
}
/** @deprecated Legacy listings cannot disclose bound credentials. */
export async function listApiKeys(db: Database) {
  const keys = await db
    .select()
    .from(apiKeys)
    .where(and(isNull(apiKeys.actorId), isNull(apiKeys.revokedAt)))
    .orderBy(apiKeys.createdAt);
  return keys.map(legacyPublicKey);
}
/** @deprecated Legacy routes cannot mutate bound credentials. */
export async function revokeApiKey(db: Database, id: string) {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          isNull(apiKeys.actorId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (!key) throw new NotFoundError("API key not found");
    await tx.insert(apiKeyEvents).values({ keyId: id, action: "revoked" });
    return legacyPublicKey(key);
  });
}
/** @deprecated Retire legacy issuance/rotation together with the old transport in A4. */
export async function rotateApiKey(
  db: Database,
  id: string,
  input?: { name?: string; expiresAt?: Date },
) {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, id),
          isNull(apiKeys.actorId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!key) throw new NotFoundError("API key not found");
    const material = generateApiKey();
    const [created] = await tx
      .insert(apiKeys)
      .values({
        name: input?.name ?? key.name,
        permissions: key.permissions,
        expiresAt: input?.expiresAt ?? key.expiresAt,
        rotatedFromId: key.id,
        keyHash: material.hash,
        keyPrefix: material.prefix,
      })
      .returning();
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id));
    await tx.insert(apiKeyEvents).values([
      { keyId: id, action: "revoked" },
      { keyId: created!.id, action: "rotated", previousKeyId: id },
    ]);
    return {
      ...legacyPublicKey(created!),
      rawKey: material.raw,
      previousKeyId: id,
    };
  });
}
