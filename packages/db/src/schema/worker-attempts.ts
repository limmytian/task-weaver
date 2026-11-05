import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { requirements } from './requirements';
import { tasks } from './tasks';

export const workerAttempts = pgTable('worker_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  credentialId: uuid('credential_id').notNull(),
  workerId: uuid('worker_id').notNull(),
  nodeId: text('node_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  planRevision: integer('plan_revision').notNull(),
  status: text('status', { enum: ['running', 'completed', 'attention', 'resolved'] }).notNull().default('running'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  resultKey: uuid('result_key'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [
  index('idx_worker_attempt_task').on(table.taskId),
  index('idx_worker_attempt_project_status').on(table.projectId, table.status),
  uniqueIndex('idx_worker_attempt_unresolved_task').on(table.taskId).where(sql`${table.status} IN ('running', 'attention')`),
  uniqueIndex('idx_worker_attempt_running_worker').on(table.workerId).where(sql`${table.status} = 'running'`),
]);
