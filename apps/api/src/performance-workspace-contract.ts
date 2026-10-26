import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createResourceServices, createRequirementSchema, requirementWorkspaceSchema } from "@task-weaver/core";
import { type Database, requirements, tasks, repositories, requirementRepositories, requirementDependencies } from "@task-weaver/db";
import type { resourcePostgresFixture } from "./resource-postgres-fixture";

/** Deliberately stale/cross-scope relations in a disposable fixture must not affect counts or graph edges. */
export async function checkWorkspaceIsolation(db: Database, f: Awaited<ReturnType<typeof resourcePostgresFixture>>) {
  const service = createResourceServices(f.owner.context).requirementService;
  const recent = await service.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: "Workspace recent", tags: ["workspace-contract"] }), f.owner.context.actor);
  const old = await service.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: "Workspace old" }), f.owner.context.actor);
  await db.update(requirements).set({ status: "archived", updatedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(requirements.id, old.id));
  const foreignProject = await f.identity.createProject(f.outsider.headers, { name: "Workspace foreign" });
  const foreign = await createResourceServices(f.outsider.context).requirementService.createRequirement(db,
    createRequirementSchema.parse({ projectId: foreignProject.id, title: "Workspace foreign" }), f.outsider.context.actor);
  await db.insert(requirementDependencies).values([
    { requirementId: recent.id, dependsOnRequirementId: old.id, type: "related" },
    { requirementId: recent.id, dependsOnRequirementId: foreign.id, type: "related" },
  ]);
  await db.insert(tasks).values([
    { projectId: f.project.id, requirementId: recent.id, title: "Workspace visible", status: "done", createdBy: f.owner.context.actor.id },
    { projectId: foreignProject.id, requirementId: recent.id, title: "Workspace moved task", status: "todo", createdBy: f.outsider.context.actor.id },
  ]);
  const [hiddenRepository] = await db.insert(repositories).values({ displayName: "Workspace private repository", host: "example.test", namespace: "fixture", name: "workspace", canonicalKey: "example.test/fixture/workspace",
    visibility: "private", ownerId: f.outsider.context.actor.id, ownerType: "human", createdBy: f.outsider.context.actor.id }).returning();
  await db.insert(requirementRepositories).values({ requirementId: recent.id, repositoryId: hiddenRepository!.id });
  const input = requirementWorkspaceSchema.parse({ projectId: f.project.id, tag: "workspace-contract", pageSize: 1 });
  const page = await service.getRequirementWorkspace(db, input);
  assert.equal(page.total, 1); assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.taskCounts.total, 1); assert.equal(page.items[0]!.taskCounts.done, 1);
  assert.equal(page.items[0]!.repositories.length, 0); assert.equal(page.summary.repositoryCount, 0);
  const graph = (await service.getRequirementWorkspace(db, { ...input, graph: true })).graph!;
  assert.ok(graph.nodes.some(row => row.id === old.id && row.external));
  assert.ok(!graph.nodes.some(row => row.id === foreign.id));
  assert.equal(graph.edges.filter(row => row.requirementId === recent.id).length, 1);
  assert.equal(graph.edges.find(row => row.requirementId === recent.id)!.dependsOnRequirementId, old.id);
  const history = await service.getRequirementWorkspace(db, { ...input, tag: undefined, completedWithinDays: 0, archived: true });
  assert.ok(history.items.some(row => row.id === old.id));
  return { movedTaskExcludedBeforeAggregation: true, privateRepositoryExcludedBeforeCounting: true,
    oldVisibleDependencyPreserved: true, foreignDependencyExcluded: true, tagBeforePagination: true, fullHistoryReachable: true };
}
