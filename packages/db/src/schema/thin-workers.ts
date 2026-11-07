import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';

export const thinWorkers = pgTable('thin_workers', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  credentialId: uuid('credential_id').notNull(),
  nodeId: text('node_id').notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  activity: text('activity', { enum: ['unknown', 'checking', 'preflight', 'acquiring', 'preparing', 'executing', 'publishing', 'idle', 'cooldown', 'attention'] }).notNull().default('unknown'),
  activityChangedAt: timestamp('activity_changed_at', { withTimezone: true }).notNull().defaultNow(),
  activityReason: text('activity_reason'),
  retryAt: timestamp('retry_at', { withTimezone: true }),
}, table => [index('idx_thin_workers_project_heartbeat').on(table.projectId, table.heartbeatAt)]);
