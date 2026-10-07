import { jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { twSchema } from "./schema";

/** Offline upgrade receipts contain fingerprints and counts, never resource content. */
export const authMigrationReceipts = twSchema.table("auth_migration_receipts", {
  id: uuid("id").primaryKey(),
  manifestHash: text("manifest_hash").notNull(),
  inventoryHash: text("inventory_hash").notNull(),
  result: jsonb("result").$type<Record<string, number>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
