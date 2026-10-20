import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { type Database, tasks, requirements, executionSlices, documents, taskDependencies, requirementDependencies, documentTaskLinks, documentRequirementLinks, taskClaims, requirementClaims, activityLog, taskComments, taskNotes } from "@task-weaver/db";
import type { VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "../services/auth-security";
import { resourceAuthority, requireResource, resourcePredicate, taskResourcePredicate } from "../services/resource-authorization";

const taskColumns = { id: tasks.id, title: sql<string>`left(${tasks.title}, 128)`, status: tasks.status, assignee: tasks.assignee, priority: tasks.priority, projectId: tasks.projectId, requirementId: tasks.requirementId, executionSliceId: tasks.executionSliceId, version: tasks.version, updatedAt: tasks.updatedAt };
const requirementColumns = { id: requirements.id, title: sql<string>`left(${requirements.title}, 128)`, status: requirements.status, priority: requirements.priority, projectId: requirements.projectId, updatedAt: requirements.updatedAt };
const sliceColumns = { id: executionSlices.id, title: sql<string>`left(${executionSlices.title}, 128)`, status: executionSlices.status, orderIndex: executionSlices.orderIndex, allowParallel: executionSlices.allowParallel, resultSummary: sql<string | null>`left(${executionSlices.resultSummary}, 1024)`, updatedAt: executionSlices.updatedAt };

/** Read-committed sections are bounded independently and never imply an atomic snapshot. */
export async function readMcpContext(db: Database, identity: VerifiedRequestContext, kind: "task" | "requirement", input: { id: string; sections: string[]; limit: number; offset: number; maxBytes: number }, signal: AbortSignal) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database, authority = await resourceAuthority(tx, identity);
    await requireResource(database, authority, kind, input.id);
    const root = kind === "task"
      ? (await tx.select(taskColumns).from(tasks).where(eq(tasks.id, input.id)))[0]!
      : (await tx.select(requirementColumns).from(requirements).where(eq(requirements.id, input.id)))[0]!;
    const requirementId = kind === "requirement" ? input.id : (root as typeof tasks.$inferSelect).requirementId;
    const output = { entity: root, sections: {} as Record<string, { items: unknown[]; hasMore: boolean; nextOffset: number | null; continuation: string }>, meta: { consistency: "read_committed_not_snapshot", fetchedAt: new Date().toISOString(), maxBytes: input.maxBytes, truncatedSections: [] as string[], omittedSections: [] as string[] } };
    for (const section of new Set(input.sections)) {
      signal.throwIfAborted();
      let rows: unknown[] = [], continuation = "";
      if (section === "parent" && kind === "task" && requirementId) {
        await requireResource(database, authority, "requirement", requirementId);
        rows = await tx.select(requirementColumns).from(requirements).where(eq(requirements.id, requirementId)).limit(1);
        continuation = "tw_requirements_get";
      } else if (section === "tasks" && requirementId) {
        await requireResource(database, authority, "requirement", requirementId);
        rows = await tx.select(taskColumns).from(tasks).where(and(eq(tasks.requirementId, requirementId), taskResourcePredicate(authority))).orderBy(tasks.id).limit(input.limit + 1).offset(input.offset);
        continuation = "tw_tasks_list";
      } else if (section === "slices" && requirementId) {
        await requireResource(database, authority, "requirement", requirementId);
        rows = await tx.select(sliceColumns).from(executionSlices).where(eq(executionSlices.requirementId, requirementId)).orderBy(asc(executionSlices.orderIndex), executionSlices.id).limit(input.limit + 1).offset(input.offset);
        continuation = "tw_execution_slices_list";
      } else if (section === "documents") {
        const columns = { id: documents.id, title: sql<string>`left(${documents.title}, 128)`, summary: sql<string | null>`left(${documents.summary}, 1024)`, version: documents.version, updatedAt: documents.updatedAt };
        rows = kind === "task"
          ? await tx.select(columns).from(documents).innerJoin(documentTaskLinks, eq(documentTaskLinks.documentId, documents.id)).where(and(eq(documentTaskLinks.taskId, input.id), resourcePredicate(authority, documents))).orderBy(documents.id).limit(input.limit + 1).offset(input.offset)
          : await tx.select(columns).from(documents).innerJoin(documentRequirementLinks, eq(documentRequirementLinks.documentId, documents.id)).where(and(eq(documentRequirementLinks.requirementId, input.id), resourcePredicate(authority, documents))).orderBy(documents.id).limit(input.limit + 1).offset(input.offset);
        continuation = "tw_documents_get";
      } else if (section === "dependencies") {
        if (kind === "task") {
          rows = await tx.select({ id: taskDependencies.id, taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId, type: taskDependencies.type }).from(taskDependencies).innerJoin(tasks, or(and(eq(taskDependencies.taskId, input.id), eq(tasks.id, taskDependencies.dependsOnTaskId)), and(eq(taskDependencies.dependsOnTaskId, input.id), eq(tasks.id, taskDependencies.taskId)))).where(taskResourcePredicate(authority)).orderBy(taskDependencies.id).limit(input.limit + 1).offset(input.offset);
          continuation = "tw_task_dependencies_list";
        } else {
          rows = await tx.select({ id: requirementDependencies.id, requirementId: requirementDependencies.requirementId, dependsOnRequirementId: requirementDependencies.dependsOnRequirementId, type: requirementDependencies.type }).from(requirementDependencies).innerJoin(requirements, or(and(eq(requirementDependencies.requirementId, input.id), eq(requirements.id, requirementDependencies.dependsOnRequirementId)), and(eq(requirementDependencies.dependsOnRequirementId, input.id), eq(requirements.id, requirementDependencies.requirementId)))).where(resourcePredicate(authority, requirements)).orderBy(requirementDependencies.id).limit(input.limit + 1).offset(input.offset);
          continuation = "tw_requirement_dependencies_list";
        }
      } else if ((section === "comments" || section === "notes") && kind === "task") {
        const table = section === "comments" ? taskComments : taskNotes;
        rows = await tx.select({ id: table.id, content: sql<string>`left(${table.content}, 2048)`, authorId: table.authorId, authorType: table.authorType, createdAt: table.createdAt, updatedAt: table.updatedAt }).from(table).where(eq(table.taskId, input.id)).orderBy(desc(table.createdAt), table.id).limit(input.limit + 1).offset(input.offset);
        continuation = "Refresh this task context section with the next offset; use REST for full text";
      } else if (section === "claim") {
        const table = kind === "task" ? taskClaims : requirementClaims;
        rows = await tx.select({ claimedBy: table.claimedBy, claimedByType: table.claimedByType, expiresAt: table.expiresAt }).from(table).where(and(eq(kind === "task" ? taskClaims.taskId : requirementClaims.requirementId, input.id), gt(table.expiresAt, new Date()))).limit(1);
        continuation = "Refresh the context claim section";
      } else if (section === "activity") {
        await requireResource(database, authority, kind, input.id, "audit.read");
        rows = await tx.select({ id: activityLog.id, action: activityLog.action, actorId: activityLog.actorId, actorType: activityLog.actorType, createdAt: activityLog.createdAt }).from(activityLog).where(and(eq(activityLog.entityType, kind), eq(activityLog.entityId, input.id))).orderBy(desc(activityLog.createdAt), activityLog.id).limit(input.limit + 1).offset(input.offset);
        continuation = "tw activity --entity with pagination via REST";
      }
      if (!continuation) { output.meta.omittedSections.push(section); continue; }
      const value = { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit, nextOffset: null as number | null, continuation };
      output.sections[section] = value;
      while (Buffer.byteLength(JSON.stringify(output), "utf8") > input.maxBytes && value.items.length) { value.items.pop(); value.hasMore = true; }
      if (value.hasMore) {
        value.nextOffset = input.offset + value.items.length;
        output.meta.truncatedSections.push(section);
        value.continuation = `Call tw_${kind === "task" ? "tasks" : "requirements"}_context with the same id, sections: ["${section}"], offset: ${value.nextOffset}; use ${continuation} for individual details. If no item fits, increase maxBytes.`;
      }
      // Reserve room for truncation metadata in the final response.
      if (Buffer.byteLength(JSON.stringify(output), "utf8") > input.maxBytes - 512) {
        delete output.sections[section];
        output.meta.omittedSections.push(section);
      }
    }
    return output;
  });
}
