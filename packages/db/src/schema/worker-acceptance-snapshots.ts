import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { repositories } from './repositories';
import { workerAttempts } from './worker-attempts';

/** Immutable server-observed repository snapshots reviewed by an acceptance attempt. */
export const workerAcceptanceSnapshots = pgTable('worker_acceptance_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().references(() => workerAttempts.id, { onDelete: 'restrict' }),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'restrict' }),
  branch: text('branch').notNull(),
  commit: text('commit').notNull(),
  repositoryIdentity: text('repository_identity').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('idx_worker_acceptance_snapshot_attempt_repository').on(table.attemptId, table.repositoryId)]);
