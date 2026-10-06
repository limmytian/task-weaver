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
    index("idx_webhook_deliveries_webhook").on(table.webhookId),
    index("idx_webhook_deliveries_status").on(table.status),
    index("idx_webhook_deliveries_created").on(table.createdAt),
  ],
);
