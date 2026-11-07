import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { repositories } from './repositories';
import { workerAttempts } from './worker-attempts';

export const thinGitDeliveries = pgTable('thin_git_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'restrict' }),
  attemptId: uuid('attempt_id').notNull().references(() => workerAttempts.id, { onDelete: 'restrict' }),
  operationKey: uuid('operation_key').notNull(),
  purpose: text('purpose', { enum: ['task', 'integration'] }).notNull().default('task'),
  acceptanceAttemptId: uuid('acceptance_attempt_id').references(() => workerAttempts.id, { onDelete: 'restrict' }),
  acceptedCommit: text('accepted_commit'),
  sourceBranch: text('source_branch'),
  targetBranch: text('target_branch').notNull(),
  expectedHead: text('expected_head').notNull(),
  proposedHead: text('proposed_head').notNull(),
  state: text('state', { enum: ['prepared', 'pushing', 'confirmed', 'uncertain', 'abandoned'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('idx_thin_git_delivery_operation').on(table.projectId, table.operationKey),
  uniqueIndex('idx_thin_git_delivery_active_branch').on(table.repositoryId, table.targetBranch).where(sql`${table.state} IN ('prepared', 'pushing', 'uncertain')`),
]);
