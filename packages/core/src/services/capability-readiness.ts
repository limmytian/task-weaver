import { and, count, eq, exists, gt, sql } from 'drizzle-orm';
import { documents, memories, mcpServers, mcpTools, skillPackages, skillPackageVersions, skillPackageFiles, type Database } from '@task-weaver/db';
import { AuthorizationError, projectCapabilityReadinessQuerySchema, projectCapabilityReadinessSchema, type CapabilityAvailability, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { canAccessResource, memoryResourcePredicate, requireResource, resourceAuthority, resourcePredicate } from './resource-authorization';
import { mcpInvocationPredicate, mcpToolInvocationPredicate } from './mcp-authorization';

/** Metadata candidates only. Storage, exact schemas/graphs and invocation stay on demand. */
export function createCapabilityReadinessService(context: VerifiedRequestContext) {
  return {
    async get(db: Database, raw: unknown, hostedExecution: CapabilityAvailability | null) {
      const input = projectCapabilityReadinessQuerySchema.parse(raw);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        // The worker's existing bounded bootstrap remains its readiness entry;
        // this project aggregate must not expand a frozen delegation's lists.
        if (authority.bounds) throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId, 'resource.read');
        const now = new Date();
        const readableText = (column: typeof documents.content | typeof memories.content) => sql`octet_length(${column}) BETWEEN 1 AND 32768`;
        const skillScope = and(eq(documents.projectId, input.projectId), eq(documents.docType, 'skill'), resourcePredicate(authority, documents));
        const memoryScope = and(eq(memories.projectId, input.projectId), memoryResourcePredicate(authority));
        const packageScope = and(eq(skillPackages.projectId, input.projectId), eq(skillPackages.status, 'active'), resourcePredicate(authority, skillPackages));
        const packageEntry = tx.select({ id: skillPackageFiles.id }).from(skillPackageVersions).innerJoin(skillPackageFiles, eq(skillPackageFiles.packageVersionId, skillPackageVersions.id))
          .where(and(eq(skillPackageVersions.packageId, skillPackages.id), eq(skillPackageVersions.status, 'active'), eq(skillPackageFiles.path, skillPackageVersions.entryPath), eq(skillPackageFiles.isReadableText, true), gt(skillPackageFiles.sizeBytes, 0), sql`${skillPackageFiles.sizeBytes} <= 32768`));
        const invokeAllowed = canAccessResource(authority, { projectId: input.projectId }, 'mcp.invoke');
        const toolScope = and(eq(mcpServers.projectId, input.projectId), mcpInvocationPredicate(authority, context), mcpToolInvocationPredicate(authority));
        const [skills] = await tx.select({ registered: count(), contentCandidates: sql<number>`count(*) FILTER (WHERE ${readableText(documents.content)})`.mapWith(Number) }).from(documents).where(skillScope);
        const [memory] = await tx.select({ registered: count(), contentCandidates: sql<number>`count(*) FILTER (WHERE ${readableText(memories.content)} AND (${memories.expiresAt} IS NULL OR ${memories.expiresAt} > ${now.toISOString()}))`.mapWith(Number) }).from(memories).where(memoryScope);
        const [packages] = await tx.select({ registered: count(), contentCandidates: sql<number>`count(*) FILTER (WHERE ${exists(packageEntry)})`.mapWith(Number) }).from(skillPackages).where(packageScope);
        const [tools] = await tx.select({ registered: count(), contentCandidates: sql<number>`count(*) FILTER (WHERE ${mcpServers.active} = true AND ${mcpServers.status} = 'connected' AND ${mcpTools.inputSchema} IS NOT NULL AND (${mcpServers.expiresAt} IS NULL OR ${mcpServers.expiresAt} > ${now.toISOString()}))`.mapWith(Number) }).from(mcpTools).innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId)).where(toolScope);
        return projectCapabilityReadinessSchema.parse({
          schemaVersion: 1, projectId: input.projectId, observedAt: now.toISOString(), scope: 'selected_project_only', readPermission: 'granted',
          invokePermission: invokeAllowed ? 'granted' : 'missing',
          inventory: [{ kind: 'skill', access: 'granted', ...skills, inspectionRequired: true }, { kind: 'skill_package', access: 'granted', ...packages, inspectionRequired: true }, { kind: 'memory', access: 'granted', ...memory, inspectionRequired: true }, { kind: 'mcp_tool', access: invokeAllowed ? 'granted' : 'missing', registered: invokeAllowed ? tools?.registered : null, contentCandidates: invokeAllowed ? tools?.contentCandidates : null, inspectionRequired: true }],
          hostedExecution, runtimeSource: 'api', runtimeObservation: hostedExecution ? 'api_profile_state' : 'not_observed_for_current_permissions', checklist: [
            'Check relevance to the current task before discovering or loading content. Empty inventory or a trivial task can justify abstention.',
            'Inspect a selected exact instruction/package version or memory source. Candidate metadata does not prove readable storage, fresh sources or complete dependencies.',
            'Before invoking, inspect the exact schema/hash or graph/runtime pins, current grants, bridge and approval requirements. A registered tool or configured profile does not authorize this asset.',
            'Use instruction-only guidance when optional execution is unavailable. Do not install dependencies or widen permissions automatically.',
            'Verify the task artifact and outcomes, record concise references and unknown coverage, and save memories only with explicit reviewed-source confirmation.',
          ],
        });
      });
    },
  };
}
