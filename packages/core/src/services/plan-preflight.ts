import { eq } from "drizzle-orm";
import { type Database, tasks } from "@task-weaver/db";
import { ValidationError, type PlanInput } from "@task-weaver/contracts";
import { requireResource, type ResourceAuthority } from "./resource-authorization";
import { assertRequirementLease } from "./claims";

export async function preflightPlan(db: Database, authority: ResourceAuthority, plan: PlanInput) {
  const actor = { id: authority.actor.id, type: authority.actor.type };
  await requireResource(db, authority, "project", plan.projectId, "resource.write");
  const keys = {
    requirement: new Map(plan.requirements.map(item => [item.key, item.existingId])),
    task: new Map(plan.requirements.flatMap(item => item.tasks.map(task => [task.key, task.existingId] as const))),
    document: new Map(plan.documents.map(item => [item.key, item.existingId])),
  };
  const checked = new Set<string>();
  async function ref(kind: keyof typeof keys, key: string) {
    const id = keys[kind].has(key) ? keys[kind].get(key) : key;
    if (!id || checked.has(`${kind}:${id}`)) return;
    checked.add(`${kind}:${id}`);
    const scope = await requireResource(db, authority, kind, id, "resource.write");
    if (scope.projectId !== plan.projectId) throw new ValidationError("MCP plans must remain inside their project");
    if (kind === "requirement") await assertRequirementLease(db, id, actor);
    if (kind === "task") {
      const [task] = await db.select({ requirementId: tasks.requirementId }).from(tasks).where(eq(tasks.id, id));
      if (task?.requirementId) await assertRequirementLease(db, task.requirementId, actor);
    }
  }
  const docRef = async (value: string | { document: string }) => ref("document", typeof value === "string" ? value : value.document);
  for (const doc of plan.documents) {
    if (doc.existingId) await ref("document", doc.key);
    for (const link of doc.links) await ref("document", link.document);
  }
  for (const requirement of plan.requirements) {
    if (requirement.existingId) await ref("requirement", requirement.key);
    for (const dep of [...requirement.dependsOn, ...requirement.dependencies]) await ref("requirement", typeof dep === "string" ? dep : dep.requirement);
    for (const doc of requirement.documents) await docRef(doc);
    for (const slice of requirement.slices) for (const task of slice.tasks) await ref("task", task);
    for (const task of requirement.tasks) {
      if (task.existingId) await ref("task", task.key);
      for (const dep of [...task.dependsOn, ...task.dependencies]) await ref("task", typeof dep === "string" ? dep : dep.task);
      for (const doc of task.documents) await docRef(doc);
    }
  }
  for (const link of plan.requirementDependencies) { await ref("requirement", link.requirement); await ref("requirement", link.dependsOn); }
  for (const link of plan.taskDependencies) { await ref("task", link.task); await ref("task", link.dependsOn); }
  for (const link of plan.documentLinks) { await ref("document", link.source); await ref("document", link.target); }
  for (const link of plan.documentTaskLinks) { await ref("document", link.document); await ref("task", link.task); }
  for (const link of plan.documentRequirementLinks) { await ref("document", link.document); await ref("requirement", link.requirement); }
}

