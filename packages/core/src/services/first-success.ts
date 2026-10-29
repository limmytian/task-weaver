import { and, desc, eq, exists, gt, notInArray, sql } from "drizzle-orm";
import { planDrafts, projects, requirements, tasks, workflowOutputs, type Database } from "@task-weaver/db";
import { AuthorizationError, firstSuccessQuerySchema, firstSuccessStateSchema, SAMPLE_PROJECT_NAME, SAMPLE_PROJECT_DESCRIPTION, type VerifiedRequestContext } from "@task-weaver/contracts";
import { getArchivedResourceReadAuthority } from "./api-keys";
import { lockIdentityLifecycle } from "./auth-security";
import { canAccessResource, requireResource, resourceAuthority, taskResourcePredicate } from "./resource-authorization";

export function createFirstSuccessService(context: VerifiedRequestContext) {
  return {
    async get(db: Database, raw: unknown) {
      const input = firstSuccessQuerySchema.parse(raw);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        if (authority.bounds || authority.actor.type !== "human") throw new AuthorizationError();
        const readAuthority = await getArchivedResourceReadAuthority(tx, context);
        await requireResource(tx, readAuthority, "project", input.projectId);
        const project = (await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1))[0]!;
        const [draft] = await tx.select({ id: planDrafts.id }).from(planDrafts).where(and(eq(planDrafts.projectId, input.projectId), eq(planDrafts.state, "draft"), gt(planDrafts.expiresAt, new Date()))).orderBy(desc(planDrafts.updatedAt), desc(planDrafts.id)).limit(1);
        const [applied] = await tx.select({ id: planDrafts.id }).from(planDrafts).where(and(eq(planDrafts.projectId, input.projectId), eq(planDrafts.state, "applied"))).limit(1);
        const taskScope = and(eq(tasks.requirementId, requirements.id), eq(tasks.projectId, input.projectId), taskResourcePredicate(readAuthority));
        const hasTasks = exists(tx.select({ id: tasks.id }).from(tasks).where(taskScope));
        const unfinished = exists(tx.select({ id: tasks.id }).from(tasks).where(and(taskScope, notInArray(tasks.status, ["done", "cancelled"]))));
        const hasOutput = exists(tx.select({ id: workflowOutputs.id }).from(workflowOutputs).where(and(eq(workflowOutputs.requirementId, requirements.id), eq(workflowOutputs.workflowRevision, requirements.workflowRevision), eq(workflowOutputs.planRevision, requirements.planRevision), eq(workflowOutputs.availability, "available"))));
        const [requirement] = await tx.select({ id: requirements.id, title: sql<string>`left(${requirements.title}, 500)`, status: requirements.status, hasTasks,
          workComplete: and(hasTasks, sql`NOT (${unfinished})`)!, hasOutput,
          reviewed: and(hasOutput, sql`${requirements.workflowState} @> '{"acceptance":"complete"}'`, eq(requirements.evidenceNeedsReview, false))!,
        }).from(requirements).where(and(eq(requirements.projectId, input.projectId), notInArray(requirements.status, ["cancelled", "archived"])))
          .orderBy(desc(requirements.updatedAt), desc(requirements.id)).limit(1);
        const sample = project.name === SAMPLE_PROJECT_NAME && project.description === SAMPLE_PROJECT_DESCRIPTION;
        return firstSuccessStateSchema.parse({ projectId: input.projectId, observedAt: new Date().toISOString(), active: project.status === "active",
          canWrite: project.status === "active" && canAccessResource(authority, { projectId: input.projectId }, "resource.write"),
          sample, canArchiveSample: sample && project.status === "active" && project.createdBy === authority.actor.id && canAccessResource(authority, { projectId: input.projectId }, "project.manage"),
          draftId: draft?.id ?? null, appliedPlan: Boolean(applied), requirement: requirement ?? null,
        });
      });
    },
  };
}
