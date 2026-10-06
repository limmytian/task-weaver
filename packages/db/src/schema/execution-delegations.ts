import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authActors } from './auth';
import { apiKeys } from './api-keys';
import { projects } from './projects';
import { requirements } from './requirements';
import { daemons } from './daemons';

/** Verifiers and immutable bounds remain private; revoked rows retain execution attribution. */
export const executionDelegations = pgTable('execution_delegations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  parentCredentialId: uuid('parent_credential_id').notNull().references(() => apiKeys.id, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull().references(() => authActors.id, { onDelete: 'restrict' }),
  initiatorActorId: uuid('initiator_actor_id').notNull().references(() => authActors.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'restrict' }),
  daemonId: uuid('daemon_id').notNull().references(() => daemons.id, { onDelete: 'restrict' }),
  runId: uuid('run_id').notNull(),
  workerIndex: text('worker_index').notNull(),
  leaseGeneration: text('lease_generation').notNull(),
  purpose: text('purpose').$type<'execute' | 'review' | 'merge' | 'automation'>().notNull(),
  taskIds: uuid('task_ids').array().notNull(),
  documentIds: uuid('document_ids').array().notNull(),
  sliceIds: uuid('slice_ids').array().notNull(),
  repositoryIds: uuid('repository_ids').array().notNull(),
  grants: jsonb('grants').$type<unknown>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [
  uniqueIndex('execution_delegations_token_hash_unique').on(table.tokenHash),
  uniqueIndex('execution_delegations_active_run_unique').on(table.runId, table.purpose).where(sql`${table.revokedAt} IS NULL`),
  index('execution_delegations_subject_project_idx').on(table.actorId, table.projectId),
  check('execution_delegations_bounds_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$' AND cardinality(${table.taskIds}) > 0 AND ${table.purpose} IN ('execute', 'review', 'merge', 'automation') AND ${table.leaseGeneration} ~ '^[1-9][0-9]*$' AND ${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`),
]);
