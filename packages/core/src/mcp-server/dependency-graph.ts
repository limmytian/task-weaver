import { and, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import { tasks, requirements, taskDependencies, requirementDependencies, taskClaims, requirementClaims, type Database } from "@task-weaver/db";
import type { VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, requireResource, resourcePredicate, taskResourcePredicate } from "../services/resource-authorization";
import { lockIdentityLifecycle } from "../services/auth-security";

type GraphNode = { id: string; title: string; status: string; projectId: string | null; updatedAt: Date };

type GraphInput = { id: string; kind: "task" | "requirement"; maxDepth: number; maxNodes: number; maxEdges: number; maxBytes: number };

/** Both endpoints are authorized in SQL before each bounded traversal step. */
export async function readDependencyGraph(db: Database, identity: VerifiedRequestContext, input: GraphInput, signal: AbortSignal) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    await requireResource(tx as unknown as Database, authority, input.kind, input.id);
    const taskVisibility = taskResourcePredicate(authority);
    const requirementVisibility = resourcePredicate(authority, requirements);
    const visibleTasks = tx.select({ id: tasks.id }).from(tasks).where(taskVisibility);
    const visibleRequirements = tx.select({ id: requirements.id }).from(requirements).where(requirementVisibility);
    const readNodes = async (ids: string[]): Promise<GraphNode[]> => input.kind === "task"
      ? tx.select({ id: tasks.id, title: sql<string>`left(${tasks.title}, 128)`, status: tasks.status, projectId: tasks.projectId, updatedAt: tasks.updatedAt }).from(tasks).where(and(inArray(tasks.id, ids), taskVisibility)).orderBy(tasks.id).limit(input.maxNodes)
      : tx.select({ id: requirements.id, title: sql<string>`left(${requirements.title}, 128)`, status: requirements.status, projectId: requirements.projectId, updatedAt: requirements.updatedAt }).from(requirements).where(and(inArray(requirements.id, ids), requirementVisibility)).orderBy(requirements.id).limit(input.maxNodes);
    const root = await readNodes([input.id]);
    const output = { root: { kind: input.kind, id: input.id }, nodes: root, edges: [] as Array<{ id: string; source: string; target: string; type: string }>, claims: [] as Array<{ entityId: string; claimedBy: string; claimedByType: string; expiresAt: Date }>, meta: { fetchedAt: new Date().toISOString(), consistency: "read_committed_not_snapshot", truncated: false, maxDepth: input.maxDepth, maxNodes: input.maxNodes, maxEdges: input.maxEdges, maxBytes: input.maxBytes, continuation: "Choose a returned node as the next root to inspect another bounded neighborhood. Graph reads never change claims or dependency guards." } };
    const included = new Set(root.map(node => node.id)), seenEdges = new Set<string>();
    let frontier = [input.id];
    for (let depth = 0; depth < input.maxDepth && frontier.length; depth++) {
      signal.throwIfAborted();
      const limit = input.maxEdges - output.edges.length;
      const edges = input.kind === "task"
        ? await tx.select({ id: taskDependencies.id, source: taskDependencies.taskId, target: taskDependencies.dependsOnTaskId, type: taskDependencies.type }).from(taskDependencies).where(and(seenEdges.size ? notInArray(taskDependencies.id, [...seenEdges]) : undefined, or(inArray(taskDependencies.taskId, frontier), inArray(taskDependencies.dependsOnTaskId, frontier)), inArray(taskDependencies.taskId, visibleTasks), inArray(taskDependencies.dependsOnTaskId, visibleTasks))).orderBy(taskDependencies.id).limit(limit + 1)
        : await tx.select({ id: requirementDependencies.id, source: requirementDependencies.requirementId, target: requirementDependencies.dependsOnRequirementId, type: requirementDependencies.type }).from(requirementDependencies).where(and(seenEdges.size ? notInArray(requirementDependencies.id, [...seenEdges]) : undefined, or(inArray(requirementDependencies.requirementId, frontier), inArray(requirementDependencies.dependsOnRequirementId, frontier)), inArray(requirementDependencies.requirementId, visibleRequirements), inArray(requirementDependencies.dependsOnRequirementId, visibleRequirements))).orderBy(requirementDependencies.id).limit(limit + 1);
      const candidates = new Set<string>();
      for (const edge of edges.slice(0, limit)) for (const id of [edge.source, edge.target]) {
        if (included.has(id) || candidates.has(id)) continue;
        if (candidates.size + included.size < input.maxNodes) candidates.add(id); else output.meta.truncated = true;
      }
      const candidateRows = candidates.size ? await readNodes([...candidates]) : [];
      const candidateById = new Map(candidateRows.map(node => [node.id, node]));
      const next = new Set<string>();
      if (edges.length > limit) output.meta.truncated = true;
      for (const edge of edges.slice(0, limit)) {
        if (seenEdges.has(edge.id)) continue;
        const missing = [...new Set([edge.source, edge.target])].filter(id => !included.has(id));
        if (output.nodes.length + missing.length > input.maxNodes) { output.meta.truncated = true; continue; }
        const nodes = missing.flatMap(id => candidateById.has(id) ? [candidateById.get(id)!] : []);
        if (nodes.length !== missing.length) { output.meta.truncated = true; continue; }
        output.nodes.push(...nodes); output.edges.push(edge);
        if (Buffer.byteLength(JSON.stringify(output)) > input.maxBytes - 512) {
          output.nodes.splice(output.nodes.length - nodes.length, nodes.length); output.edges.pop(); output.meta.truncated = true; continue;
        }
        seenEdges.add(edge.id);
        for (const node of nodes) { included.add(node.id); next.add(node.id); }
      }
      frontier = [...next];
      if (depth + 1 === input.maxDepth && frontier.length) output.meta.truncated = true;
    }
    const ids = [...included];
    const claims = input.kind === "task"
      ? await tx.select({ entityId: taskClaims.taskId, claimedBy: taskClaims.claimedBy, claimedByType: taskClaims.claimedByType, expiresAt: taskClaims.expiresAt }).from(taskClaims).where(and(inArray(taskClaims.taskId, ids), gt(taskClaims.expiresAt, new Date()))).orderBy(taskClaims.taskId)
      : await tx.select({ entityId: requirementClaims.requirementId, claimedBy: requirementClaims.claimedBy, claimedByType: requirementClaims.claimedByType, expiresAt: requirementClaims.expiresAt }).from(requirementClaims).where(and(inArray(requirementClaims.requirementId, ids), gt(requirementClaims.expiresAt, new Date()))).orderBy(requirementClaims.requirementId);
    for (const claim of claims) {
      output.claims.push(claim);
      if (Buffer.byteLength(JSON.stringify(output)) > input.maxBytes) { output.claims.pop(); output.meta.truncated = true; }
    }
    return output;
  });
}
