import { and, count, desc, eq, exists, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { authAuditEvents, documents, memories, mcpServers, mcpTools, mcpInvocationAudits, skillPackages, skillPackageVersions, taskComments, taskNotes, tasks, type Database } from '@task-weaver/db';
import { AuthorizationError, capabilityEvidenceQuerySchema, capabilityEvidenceViewSchema, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { memoryResourcePredicate, requireResource, resourceAuthority, resourcePredicate, taskResourcePredicate } from './resource-authorization';
import { mcpInvocationPredicate, mcpToolInvocationPredicate } from './mcp-authorization';

/** Current asset visibility is applied in SQL before grouping, pagination or counts. */
export function createCapabilityEvidenceViewService(context: VerifiedRequestContext) {
  return { async get(db: Database, raw: unknown) {
    const input = capabilityEvidenceQuerySchema.parse(raw);
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Database;
      // Bound read-query cost while retaining the existing identity consistency lock.
      await tx.execute(sql`select set_config('statement_timeout', '3000', true)`);
      await lockIdentityLifecycle(transaction);
      const authority = await resourceAuthority(tx, context);
      if (authority.bounds) throw new AuthorizationError();
      await requireResource(tx, authority, 'project', input.projectId, 'resource.read');
      await requireResource(tx, authority, 'project', input.projectId, 'audit.read');
      const now = new Date(), since = new Date(now.getTime() - input.days * 86_400_000);
      // DISTINCT ON/ORDER BY must share identical SQL expressions. Only these
      // internal alphanumeric JSON keys become literals; query values stay bound.
      const meta = (key: string) => {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error('Invalid internal evidence field');
        return sql<string>`${authAuditEvents.metadata}->>${sql.raw("'" + key + "'")}`;
      };
      const asset = meta('assetId'), kind = meta('capabilityKind'), action = meta('capabilityAction');
      const version = meta('assetVersion'), hash = meta('assetSha256');
      const hashKind = sql<string | null>`case when ${meta('assetHashKind')} in ('content','file','manifest_graph','tool_schema') then ${meta('assetHashKind')} else null end`;
      const run = sql<string | null>`case when ${authAuditEvents.action} in ('delegation.operation','delegation.capability_invocation') and ${meta('runId')} ~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' then ${meta('runId')} else null end`;
      const group = sql`coalesce(${run}, ${meta('credentialId')}, ${authAuditEvents.entityId}::text, ${authAuditEvents.id}::text)`;
      const outcome = sql<string>`case when ${meta('capabilityOutcome')} in ('read','returned','saved') then 'observed' when ${meta('capabilityOutcome')} in ('upstream_error','invocation_failed','permission_denied','approval_required','read_only','validation_error','busy','not_found') then 'error' else 'unknown' end`;
      const window = and(gte(authAuditEvents.createdAt, since), lte(authAuditEvents.createdAt, now), sql`${meta('capabilityEvidenceVersion')} = '1'`, or(eq(meta('projectId'), input.projectId), eq(meta('scopeKey'), `project:${input.projectId}`)), inArray(authAuditEvents.action, ['delegation.operation', 'delegation.capability_invocation', 'capability.operation']));
      const visibleSkill = exists(tx.select({ id: documents.id }).from(documents).where(and(sql`${documents.id}::text = ${asset}`, eq(documents.docType, 'skill'), or(eq(documents.projectId, input.projectId), isNull(documents.projectId)), resourcePredicate(authority, documents))));
      const visibleMemory = exists(tx.select({ id: memories.id }).from(memories).where(and(sql`${memories.id}::text = ${asset}`, memoryResourcePredicate(authority), or(eq(memories.projectId, input.projectId), isNull(memories.projectId)), or(isNull(memories.expiresAt), sql`${memories.expiresAt} > ${now.toISOString()}`))));
      const visibleVersion = exists(tx.select({ id: skillPackageVersions.id }).from(skillPackageVersions).where(and(eq(skillPackageVersions.packageId, skillPackages.id), eq(skillPackageVersions.version, version), eq(skillPackageVersions.status, 'active'))));
      const visiblePackage = exists(tx.select({ id: skillPackages.id }).from(skillPackages).where(and(sql`${skillPackages.id}::text = ${asset}`, eq(skillPackages.status, 'active'), or(eq(skillPackages.projectId, input.projectId), isNull(skillPackages.projectId)), resourcePredicate(authority, skillPackages), or(and(isNull(version), isNull(hash)), visibleVersion))));
      const visibleTool = exists(tx.select({ id: mcpTools.id }).from(mcpTools).innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId)).where(and(sql`${mcpTools.id}::text = ${asset}`, or(eq(mcpServers.projectId, input.projectId), isNull(mcpServers.projectId)), mcpInvocationPredicate(authority, context), mcpToolInvocationPredicate(authority))));
      const visible = or(and(eq(kind, 'skill'), visibleSkill), and(eq(kind, 'memory'), visibleMemory), and(eq(kind, 'skill_package'), visiblePackage), and(eq(kind, 'mcp_tool'), visibleTool));
      const versionGroup = sql`coalesce(${version}, '')`, hashGroup = sql`coalesce(${hash}, '')`;
      const hashKindGroup = sql`coalesce(${hashKind}, '')`;
      const references = tx.selectDistinctOn([group, kind, asset, action, versionGroup, hashGroup, hashKindGroup, outcome], {
        id: authAuditEvents.id, kind: kind.as('kind'), assetId: asset.as('asset_id'), action: action.as('action'), outcome: outcome.as('outcome'),
        runId: run.as('run_id'), recordedAt: authAuditEvents.createdAt, assetVersion: version.as('asset_version'), assetSha256: hash.as('asset_sha256'), assetHashKind: hashKind.as('asset_hash_kind'),
        sourceFreshness: sql<string | null>`case when ${meta('sourceFreshness')} in ('current','changed','not_applicable') then ${meta('sourceFreshness')} else null end`.as('source_freshness'),
        durationMs: mcpInvocationAudits.durationMs,
      }).from(authAuditEvents).leftJoin(mcpInvocationAudits, sql`${mcpInvocationAudits.id}::text = ${meta('invocationAuditId')}`)
        .where(and(window, visible, inArray(meta('evidenceSource'), ['api', 'api_attempt']), inArray(action, ['read', 'inspect', 'resolve', 'invoke', 'save'])))
        .orderBy(group, kind, asset, action, versionGroup, hashGroup, hashKindGroup, outcome, desc(authAuditEvents.createdAt), desc(authAuditEvents.id)).as('visible_references');
      const [total] = await tx.select({ value: count() }).from(references);
      const summary = await tx.select({ action: references.action, outcome: references.outcome, references: count() }).from(references).groupBy(references.action, references.outcome);
      const rows = await tx.select().from(references).orderBy(desc(references.recordedAt), desc(references.id)).limit(input.limit).offset(input.offset);
      const reportId = meta('reportId');
      const commentVisible = exists(tx.select({ id: taskComments.id }).from(taskComments).innerJoin(tasks, eq(tasks.id, taskComments.taskId)).where(and(sql`${taskComments.id}::text = ${reportId}`, eq(tasks.projectId, input.projectId), taskResourcePredicate(authority))));
      const noteVisible = exists(tx.select({ id: taskNotes.id }).from(taskNotes).innerJoin(tasks, eq(tasks.id, taskNotes.taskId)).where(and(sql`${taskNotes.id}::text = ${reportId}`, eq(tasks.projectId, input.projectId), taskResourcePredicate(authority))));
      const [reports] = await tx.select({ value: sql<number>`count(distinct ${reportId})`.mapWith(Number) }).from(authAuditEvents).where(and(window, eq(meta('evidenceSource'), 'agent_report'), or(commentVisible, noteVisible)));
      return capabilityEvidenceViewSchema.parse({ schemaVersion: 1, projectId: input.projectId, since: since.toISOString(), observedAt: now.toISOString(), grouping: 'unique_visible_references',
        totalVisibleReferences: total!.value, reportedProgressReferences: reports!.value,
        coverage: { complete: false, discovery: 'unknown', taskUsefulness: 'not_measured', modelCost: null, contextTokens: null }, summary,
        items: rows.map(row => ({ ...row, recordedAt: row.recordedAt.toISOString(), attribution: row.runId ? 'run' : 'credential' })),
      });
    });
  } };
}
