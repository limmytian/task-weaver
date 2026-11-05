import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";

// Writers must lock the project stream row until commit while allocating a sequence.
// This prevents a later committed cursor from hiding an earlier uncommitted event.
export const eventStreams = pgTable("event_streams", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  nextSequence: bigint("next_sequence", { mode: "bigint" }).notNull().default(1n),
  retentionFloor: bigint("retention_floor", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("event_stream_bounds", sql`${t.retentionFloor} >= 0 AND ${t.nextSequence} > ${t.retentionFloor}`)]);

export const durableEvents = pgTable("durable_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => eventStreams.projectId, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  type: text("type").notNull(),
  version: integer("version").notNull(),
  scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("durable_events_project_sequence").on(t.projectId, t.sequence), check("durable_event_valid", sql`${t.sequence} > 0 AND ${t.version} > 0 AND length(${t.type}) > 0 AND jsonb_typeof(${t.scope}) = 'object' AND jsonb_typeof(${t.payload}) = 'object'`)]);

export const eventConsumers = pgTable("event_consumers", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => eventStreams.projectId, { onDelete: "cascade" }),
  principalType: text("principal_type").notNull(),
  principalId: text("principal_id").notNull(),
  name: text("name").notNull(),
  acknowledgedSequence: bigint("acknowledged_sequence", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("event_consumers_project_principal_name").on(t.projectId, t.principalType, t.principalId, t.name), index("event_consumers_project").on(t.projectId), check("event_consumer_valid", sql`${t.acknowledgedSequence} >= 0 AND length(${t.name}) > 0 AND length(${t.principalId}) > 0 AND ${t.principalType} IN ('human', 'agent')`)]);
