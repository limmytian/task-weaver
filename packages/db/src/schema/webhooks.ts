import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { authActors } from "./auth";
import { twSchema } from "./schema";

export const webhookStatusEnum = twSchema.enum("webhook_delivery_status", [
  "pending",
  "success",
  "failed",
]);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    bindingId: uuid("binding_id"),
    ownerActorId: uuid("owner_actor_id").references(() => authActors.id, { onDelete: "restrict" }),
    credentialKind: text("credential_kind"),
    credentialId: uuid("credential_id"),
    authorityCeiling: jsonb("authority_ceiling"),
    url: text("url").notNull(),
    events: jsonb("events").notNull().$type<string[]>(),
    secret: text("secret").notNull(),
    active: boolean("active").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_webhooks_project").on(table.projectId),
    index("idx_webhooks_active").on(table.active),
    check("webhooks_authority_binding_check", sql`(
      (${table.bindingId} IS NULL AND ${table.ownerActorId} IS NULL AND ${table.credentialKind} IS NULL AND ${table.credentialId} IS NULL AND ${table.authorityCeiling} IS NULL)
      OR (${table.bindingId} IS NOT NULL AND ${table.ownerActorId} IS NOT NULL AND ${table.credentialKind} IS NOT NULL AND ${table.credentialKind} IN ('session', 'api_key') AND ${table.credentialId} IS NOT NULL AND ${table.authorityCeiling} IS NOT NULL AND jsonb_typeof(${table.authorityCeiling}) = 'array')
    )`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .references(() => webhooks.id, { onDelete: "cascade" })
      .notNull(),
    bindingId: uuid("binding_id"),
    eventId: uuid("event_id"),
    replayOf: uuid("replay_of"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: webhookStatusEnum("status").notNull().default("pending"),
    httpStatus: integer("http_status"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("webhook_delivery_logical_event").on(table.webhookId, table.bindingId, table.eventId).where(sql`${table.replayOf} IS NULL`),
    index("idx_webhook_deliveries_webhook").on(table.webhookId),
    index("idx_webhook_deliveries_status").on(table.status),
    index("idx_webhook_deliveries_created").on(table.createdAt),
  ],
);

/** The business transaction owns this event; fanout may be resumed after any process restart. */
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey(),
  version: integer("version").notNull().default(1),
  eventType: text("event_type").notNull(),
  projectId: uuid("project_id"),
  actorId: text("actor_id"),
  actorType: text("actor_type"),
  causationId: uuid("causation_id"),
  correlationId: uuid("correlation_id").notNull(),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  expandedAt: timestamp("expanded_at", { withTimezone: true }),
}, table => [index("webhook_events_pending").on(table.expandedAt, table.occurredAt)]);

export const webhookDeliveryAttempts = pgTable("webhook_delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id").notNull().references(() => webhookDeliveries.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  outcome: text("outcome", { enum: ["pending", "success", "failed", "unknown", "revoked"] }).notNull(),
  httpStatus: integer("http_status"),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, table => [uniqueIndex("webhook_attempt_identity").on(table.deliveryId, table.attempt)]);
