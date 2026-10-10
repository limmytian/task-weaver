import { revokeActorExecutions } from './execution-revocation';
import { liveExecutionAuthority, type ExecutionBounds } from './execution-delegations';
import { eq, and, gt, isNull, or, inArray } from "drizzle-orm";
import {
  type Database,
  apiKeys,
  apiKeyEvents,
  authSessions,
  executionDelegations,
} from "@task-weaver/db";
import { createHash, randomBytes } from "node:crypto";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
  updateApiKeyGrantsSchema,
  apiKeyDtoSchema,
  credentialGrantsSchema,
  issueScopedApiKeySchema,
  requestIdentitySnapshotSchema,
  type AuthorizationGrant,
  type Principal,
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
export function publicScopedApiKey(key: StoredKey) {
  return apiKeyDtoSchema.parse({
    id: key.id,
    actorId: key.actorId,
    issuedByActorId: key.issuedByActorId,
    name: key.name,
    prefix: key.keyPrefix,
    grants: key.grants,
    grantVersion: key.grantVersion,
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
  includeArchived = false,
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
    await loadPrincipalGrants(db, actor.id, includeArchived),
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
    const authority = await liveKeyAuthority(db, parent, now, seen, includeArchived);
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
  context: { actor: { id: string }; credential: { kind: string; id: string; actorId: string } },
  now: Date,
  includeArchived = false,
): Promise<{ actor: Principal; grants: AuthorizationGrant[]; key: StoredKey | null; depth: number; bounds?: ExecutionBounds | null }> {
  const actor = await loadActivePrincipal(db, context.actor.id);
  if (context.credential.actorId !== actor.id)
    throw new AuthenticationError("invalid_credential");
  if (context.credential.kind === "delegation") {
    const authority = await liveExecutionAuthority(db, context.credential.id, now);
    if (authority.actor.id !== actor.id) throw new AuthenticationError("invalid_credential");
    return { ...authority, key: null, depth: 0 };
  }
  if (context.credential.kind === "api_key") {
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, context.credential.id))
      .limit(1);
    if (!key || key.actorId !== actor.id)
      throw new AuthenticationError("invalid_credential");
    return { ...(await liveKeyAuthority(db, key, now, new Set(), includeArchived)), key };
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
    grants: await loadPrincipalGrants(db, actor.id, includeArchived),
    key: null,
    depth: 0,
  };
}
/** Internal persisted integrations resolve credential bindings through the same live authority. */
export async function getBoundCredentialAuthority(db: AuthDatabase, binding: { actorId: string; credentialId: string; credentialKind: string }): Promise<{ actor: Principal; grants: AuthorizationGrant[] }> {
  if (!["api_key", "session"].includes(binding.credentialKind)) throw new AuthorizationError();
  const { actor, grants } = await currentAuthority(db, {
    actor: { id: binding.actorId },
    credential: { id: binding.credentialId, kind: binding.credentialKind, actorId: binding.actorId },
  }, new Date());
  return { actor, grants };
}

/** Safe live authority for lifecycle services; stored credentials never leave this module. */
export async function getLiveRequestAuthority(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  now = new Date(),
): Promise<{ actor: Principal; grants: AuthorizationGrant[]; bounds?: ExecutionBounds | null }> {
  const authority = await currentAuthority(db, context, now);
  const bounds: ExecutionBounds | null = authority.bounds ?? null;
  return { actor: authority.actor, grants: authority.grants, bounds };
}

/** Project inventory can include archived memberships without granting live operations. */
export async function getProjectInventoryAuthority(db: AuthDatabase, context: VerifiedRequestContext) {
  const authority = await currentAuthority(db, context, new Date(), true);
  if (authority.bounds) throw new AuthorizationError();
  return { actor: authority.actor, grants: authority.grants.map(grant => ({
    ...grant, permissions: grant.permissions.filter(permission => permission === "resource.read"),
  })).filter(grant => grant.permissions.length > 0), bounds: null };
}

/** Archived project browsing adds only read/audit permissions; active entitlements stay unchanged. */
export async function getArchivedResourceReadAuthority(db: AuthDatabase, context: VerifiedRequestContext) {
  const live = await getLiveRequestAuthority(db, context);
  if (live.bounds) throw new AuthorizationError();
  const historical = await currentAuthority(db, context, new Date(), true);
  const activeProjects = new Set(live.grants.flatMap(grant => grant.scope === "project" ? [grant.projectId] : []));
  const archived = historical.grants.filter(grant => grant.scope === "project" && !activeProjects.has(grant.projectId))
    .map(grant => ({ ...grant, permissions: grant.permissions.filter(permission => ["resource.read", "audit.read"].includes(permission)) }))
    .filter(grant => grant.permissions.length > 0);
  return { ...live, grants: [...live.grants, ...archived] };
}

/** Historical snapshots retain archived membership reads under current credential ceilings. */
export async function getHistoricalReadAuthority(db: AuthDatabase, context: VerifiedRequestContext) {
  const authority = await getProjectInventoryAuthority(db, context);
  if (authority.actor.type !== "human") throw new AuthorizationError();
  return authority;
}

export async function credentialManager(
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
export async function keyManager(
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

/** Compose lifecycle transactions without changing standalone serializable behavior. */
async function withCredentialTransaction<T>(
  db: AuthDatabase,
  work: (tx: AuthDatabase) => Promise<T>,
): Promise<T> {
  return "$client" in db
    ? db.transaction(work, { isolationLevel: "serializable" })
    : db.transaction(work);
}

/** The subject parameter is a server-resolved self/managed-agent target, never a trusted body field. */
export async function issueScopedApiKey(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  actorId: string,
  input: IssueScopedApiKey,
) {
  const parsed = issueScopedApiKeySchema.parse(input);
  return withCredentialTransaction(db, async (tx) => {
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
    return { ...publicScopedApiKey(created!), rawKey: material.raw };
  });
}

/** Grant updates permanently invalidate every descendant, including execution capabilities. */
export async function updateScopedApiKeyGrants(db: AuthDatabase, context: VerifiedRequestContext, actorId: string, id: string, input: unknown) {
  const parsed = updateApiKeyGrantsSchema.parse(input);
  return withCredentialTransaction(db, async tx => {
    const now = new Date();
    const [key] = await tx.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.actorId, actorId))).limit(1).for("update");
    if (!key) throw new NotFoundError("API key not found");
    const authority = await keyManager(tx, context, actorId, now);
    if (authority.bounds) throw new AuthorizationError();
    await liveKeyAuthority(tx, key, now);
    if (key.grantVersion !== parsed.expectedVersion) throw new ConflictError("Key grants changed; refresh before saving", key.grantVersion);
    if (!grantsAreCovered(parsed.grants, authority.grants) || !grantsAreCovered(parsed.grants, await loadPrincipalGrants(tx, actorId))) throw new AuthorizationError();
    if (key.parentKeyId) {
      const [parent] = await tx.select().from(apiKeys).where(eq(apiKeys.id, key.parentKeyId)).limit(1);
      if (!parent || !grantsAreCovered(parsed.grants, (await liveKeyAuthority(tx, parent, now)).grants)) throw new AuthorizationError();
    }
    const previous = credentialGrantsSchema.parse(key.grants);
    if (grantsAreCovered(previous, parsed.grants) && grantsAreCovered(parsed.grants, previous)) {
      return { key: publicScopedApiKey(key), changed: false };
    }
    const descendants = [id];
    let frontier = [id];
    while (frontier.length) {
      const children = await tx.select({ id: apiKeys.id }).from(apiKeys).where(inArray(apiKeys.parentKeyId, frontier));
      frontier = children.map(child => child.id).filter(child => !descendants.includes(child));
      descendants.push(...frontier);
    }
    if (descendants.length > 1) await tx.update(apiKeys).set({ revokedAt: now, revokedByActorId: authority.actor.id }).where(and(inArray(apiKeys.id, descendants.slice(1)), isNull(apiKeys.revokedAt)));
    await tx.update(executionDelegations).set({ revokedAt: now }).where(and(inArray(executionDelegations.parentCredentialId, descendants), isNull(executionDelegations.revokedAt)));
    const [updated] = await tx.update(apiKeys).set({ grants: parsed.grants, grantVersion: key.grantVersion + 1 }).where(eq(apiKeys.id, id)).returning();
    return { key: publicScopedApiKey(updated!), changed: true };
  });
}

export async function listScopedApiKeys(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  actorId: string,
) {
  await credentialManager(db, context, actorId, new Date(), true);
  const keys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.actorId, actorId), isNull(apiKeys.revokedAt)))
    .orderBy(apiKeys.createdAt);
  return keys.map(publicScopedApiKey);
}

export async function revokeScopedApiKey(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  id: string,
) {
  return withCredentialTransaction(db, async (tx) => {
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
    if (key.revokedAt) return publicScopedApiKey(key);
    await revokeActorExecutions(tx, key.actorId);
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedByActorId: authority.actor.id })
      .where(eq(apiKeys.id, id))
      .returning();
    await tx
      .insert(apiKeyEvents)
      .values({ keyId: id, actorId: authority.actor.id, action: "revoked" });
    return publicScopedApiKey(revoked!);
  });
}

export async function rotateScopedApiKey(
  db: AuthDatabase,
  context: VerifiedRequestContext,
  id: string,
) {
  return withCredentialTransaction(db, async (tx) => {
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
    await revokeActorExecutions(tx, key.actorId);
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
      ...publicScopedApiKey(created!),
      rawKey: material.raw,
      previousKeyId: id,
    };
  });
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
