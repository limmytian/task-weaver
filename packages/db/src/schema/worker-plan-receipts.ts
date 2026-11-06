import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { workerAttempts } from './worker-attempts';
import { planDrafts } from './plan-drafts';

export const workerPlanReceipts = pgTable('worker_plan_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  attemptId: uuid('attempt_id').notNull().references(() => workerAttempts.id, { onDelete: 'restrict' }),
  operationKey: uuid('operation_key').notNull(),
  draftId: uuid('draft_id').notNull().references(() => planDrafts.id, { onDelete: 'restrict' }),
  planDigest: text('plan_digest').notNull(),
  resultingRevision: integer('resulting_revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('idx_worker_plan_operation').on(table.projectId, table.operationKey)]);
