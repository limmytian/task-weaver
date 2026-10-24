import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { requirements } from './requirements';

/** Durable control state survives SSE loss and daemon restarts. It is not a file checkpoint. */
export const executionControls = pgTable('execution_controls', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull(),
  daemonId: uuid('daemon_id').notNull(),
  runId: uuid('run_id').notNull(),
  revision: integer('revision').notNull(),
  reason: text('reason').notNull(),
  phase: text('phase', { enum: ['pending', 'received', 'stopping', 'stopped', 'reconciling', 'resumed', 'blocked', 'manual'] }).notNull().default('pending'),
  workspace: jsonb('workspace').$type<Record<string, unknown>>(),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('idx_execution_controls_run').on(table.runId), index('idx_execution_controls_daemon').on(table.daemonId, table.updatedAt), index('idx_execution_controls_requirement').on(table.requirementId, table.createdAt)]);

export const executionSynchronizations = pgTable('execution_synchronizations', {
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  planRevision: integer('plan_revision').notNull(),
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull(),
  repositoryId: uuid('repository_id').notNull(),
  remoteTip: text('remote_tip').notNull(),
  localHead: text('local_head').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('idx_execution_sync_run_repository').on(table.runId, table.repositoryId), index('idx_execution_sync_requirement').on(table.requirementId, table.verifiedAt)]);
