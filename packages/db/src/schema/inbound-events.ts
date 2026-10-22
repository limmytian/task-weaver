import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Integration bindings are revocable references; no actor or authority comes from event payloads. */
export const inboundSources = pgTable("inbound_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), projectId: uuid("project_id").notNull(), requirementId: uuid("requirement_id").notNull(),
  ownerActorId: uuid("owner_actor_id").notNull(), credentialId: uuid("credential_id").notNull(), credentialKind: text("credential_kind").notNull(),
  authorityCeiling: jsonb("authority_ceiling").notNull(), bindingId: uuid("binding_id").notNull().defaultRandom(),
  secret: text("secret").notNull(), active: boolean("active").notNull().default(true), rules: jsonb("rules").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("inbound_sources_project").on(table.projectId)]);

export const inboundEvents = pgTable("inbound_events", {
  id: uuid("id").primaryKey().defaultRandom(), sourceId: uuid("source_id").notNull().references(() => inboundSources.id),
  bindingId: uuid("binding_id").notNull(), externalId: text("external_id").notNull(), eventType: text("event_type").notNull(), payloadHash: text("payload_hash").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["pending", "processing", "processed", "ignored", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseId: uuid("lease_id"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), errorCode: text("error_code"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), processedAt: timestamp("processed_at", { withTimezone: true }),
}, table => [uniqueIndex("inbound_event_identity").on(table.sourceId, table.bindingId, table.externalId), index("inbound_events_pending").on(table.status, table.nextAttemptAt)]);

export const inboundActionReceipts = pgTable("inbound_action_receipts", {
  id: uuid("id").primaryKey().defaultRandom(), eventId: uuid("event_id").notNull().references(() => inboundEvents.id),
  ruleId: uuid("rule_id").notNull(), actionIndex: integer("action_index").notNull(), actionType: text("action_type").notNull(),
  entityId: uuid("entity_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("inbound_action_identity").on(table.eventId, table.ruleId, table.actionIndex)]);
