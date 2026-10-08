import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { daemons } from "./daemons";

export const executorAvailability = pgTable("executor_availability", {
  id: uuid("id").primaryKey().defaultRandom(),
  daemonId: uuid("daemon_id").notNull().references(() => daemons.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  tool: text("tool").notNull(),
  profileId: text("profile_id").notNull(),
  poolId: text("pool_id"),
  observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  refreshRequestedAt: timestamp("refresh_requested_at", { withTimezone: true }),
  blockCount: integer("block_count").notNull().default(0),
  version: integer("version").notNull().default(1),
}, table => [uniqueIndex("executor_availability_daemon_tool").on(table.daemonId, table.tool), index("executor_availability_pool").on(table.actorId, table.poolId)]);
export const executorAvailabilityEvents = pgTable("executor_availability_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  daemonId: uuid("daemon_id").notNull().references(() => daemons.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  profileId: text("profile_id").notNull(),
  eventId: uuid("event_id").notNull(),
  state: text("state").notNull(),
  reason: text("reason").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, table => [uniqueIndex("executor_availability_event_id").on(table.daemonId, table.eventId), index("executor_availability_event_time").on(table.daemonId, table.observedAt)]);
