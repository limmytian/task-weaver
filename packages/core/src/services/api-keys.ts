import { eq, and, gt, isNull, or } from "drizzle-orm";
import { type Database, apiKeys } from "@task-weaver/db";
import { createHash, randomBytes } from "node:crypto";
import { NotFoundError } from "@task-weaver/contracts";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `tw_${randomBytes(32).toString("hex")}`;
  const prefix = raw.slice(0, 10);
  const hash = hashKey(raw);
  return { raw, prefix, hash };
}

export async function createApiKey(
  db: Database,
  input: {
    name: string;
    permissions?: Record<string, boolean>;
    expiresAt?: Date;
  },
) {
  const { raw, prefix, hash } = generateApiKey();

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      name: input.name,
      keyHash: hash,
      keyPrefix: prefix,
      permissions: input.permissions,
      expiresAt: input.expiresAt,
    })
    .returning();

  // Return the raw key only on creation
  return { ...apiKey!, rawKey: raw };
}

export async function validateApiKey(db: Database, rawKey: string) {
  const hash = hashKey(rawKey);

  const [key] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, hash),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);

  if (!key) return null;

  // Update last used timestamp
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id));

  return key;
}

export async function listApiKeys(db: Database) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      permissions: apiKeys.permissions,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .orderBy(apiKeys.createdAt);
}

export async function revokeApiKey(db: Database, id: string) {
  const [deleted] = await db
    .delete(apiKeys)
    .where(eq(apiKeys.id, id))
    .returning();
  if (!deleted) throw new NotFoundError("API key not found");
  return deleted;
}

export async function rotateApiKey(
  db: Database,
  id: string,
  input?: { name?: string; expiresAt?: Date },
) {
  // Verify old key exists
  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  if (!existing) throw new NotFoundError("API key not found");

  const { raw, prefix, hash } = generateApiKey();

  // Atomic: create new key + delete old key
  const [newKey] = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        name: input?.name ?? existing.name,
        keyHash: hash,
        keyPrefix: prefix,
        permissions: existing.permissions,
        expiresAt: input?.expiresAt ?? existing.expiresAt,
      })
      .returning();

    await tx.delete(apiKeys).where(eq(apiKeys.id, id));

    return [created];
  });

  return { ...newKey!, rawKey: raw, previousKeyId: id };
}
