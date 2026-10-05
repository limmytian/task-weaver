import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authActors } from "./auth";

/** Legacy rows remain unbound until an explicit reviewed ownership migration. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    permissions: jsonb("permissions"),
    actorId: uuid("actor_id").references(() => authActors.id, {
      onDelete: "restrict",
    }),
    issuedByActorId: uuid("issued_by_actor_id").references(
      () => authActors.id,
      { onDelete: "restrict" },
    ),
    grants: jsonb("grants"),
    parentKeyId: uuid("parent_key_id").references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: "restrict" },
    ),
    rotatedFromId: uuid("rotated_from_id").references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: "restrict" },
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByActorId: uuid("revoked_by_actor_id").references(
      () => authActors.id,
      { onDelete: "restrict" },
    ),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "api_keys_binding_check",
      sql`(${table.actorId} IS NULL AND ${table.issuedByActorId} IS NULL AND ${table.grants} IS NULL AND ${table.parentKeyId} IS NULL) OR (${table.actorId} IS NOT NULL AND ${table.issuedByActorId} IS NOT NULL AND ${table.grants} IS NOT NULL AND jsonb_typeof(${table.grants}) = 'array' AND jsonb_array_length(${table.grants}) BETWEEN 1 AND 100)`,
    ),
    check(
      "api_keys_parent_check",
      sql`${table.parentKeyId} IS NULL OR ${table.parentKeyId} <> ${table.id}`,
    ),
    check(
      "api_keys_bound_hash_check",
      sql`${table.actorId} IS NULL OR ${table.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "api_keys_bound_expiry_check",
      sql`${table.actorId} IS NULL OR ${table.expiresAt} IS NULL OR (isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt})`,
    ),
    uniqueIndex("api_keys_bound_hash_unique")
      .on(table.keyHash)
      .where(sql`${table.actorId} IS NOT NULL`),
    uniqueIndex("api_keys_rotation_unique")
      .on(table.rotatedFromId)
      .where(sql`${table.rotatedFromId} IS NOT NULL`),
    index("api_keys_actor_idx").on(table.actorId, table.revokedAt),
    index("api_keys_parent_idx").on(table.parentKeyId),
  ],
);

export const apiKeyEvents = pgTable(
  "api_key_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id").references(() => authActors.id, {
      onDelete: "restrict",
    }),
    action: text("action", {
      enum: ["issued", "revoked", "rotated"],
    }).notNull(),
    previousKeyId: uuid("previous_key_id").references(() => apiKeys.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "api_key_events_action_check",
      sql`${table.action} IN ('issued', 'revoked', 'rotated')`,
    ),
    index("api_key_events_key_idx").on(table.keyId, table.createdAt),
  ],
);
