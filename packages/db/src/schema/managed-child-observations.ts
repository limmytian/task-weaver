import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { requirements } from './requirements';

/** A supervisor's spawn binding and subsequent direct-child exit report. */
export const managedChildObservations = pgTable('managed_child_observations', {
  runId: uuid('run_id').primaryKey(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  daemonId: uuid('daemon_id').notNull(),
  leaseGeneration: integer('lease_generation').notNull(),
  pid: integer('pid').notNull(),
  processIdentity: text('process_identity').notNull(),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp('exited_at', { withTimezone: true }),
  exitStatus: integer('exit_status'),
  signal: text('signal'),
});
