import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { documents, projects } from "@task-weaver/db";
import { AuthorizationError } from "@task-weaver/contracts";
import { canAccessResource, projectPredicate, resourcePredicate, requireScope, type ResourceAuthority } from "./resource-authorization";
import { projectService, taskService, documentService, createResourceServices } from "./resource-services";

const human = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const authority: ResourceAuthority = {
  actor: { id: human, userId: human, type: "human", status: "active", instanceRole: "admin" },
  grants: [
    { scope: "personal", actorId: human, permissions: ["resource.read", "resource.write"] },
    { scope: "project", projectId: project, permissions: ["resource.read"] },
    { scope: "instance", permissions: ["instance.manage"] },
  ],
};
test("instance administration never substitutes for resource scope", () => {
  assert.equal(canAccessResource(authority, { projectId: other }), false);
  assert.equal(canAccessResource(authority, { personalOwnerId: other, personalOwnerType: "human" }), false);
  assert.equal(canAccessResource(authority, {}), false);
});
test("viewer cannot mutate; personal ownership is human-bound", () => {
  assert.equal(canAccessResource(authority, { projectId: project }), true);
  assert.throws(() => requireScope(authority, { projectId: project }), AuthorizationError);
  assert.equal(canAccessResource(authority, { personalOwnerId: human, personalOwnerType: "human" }, "resource.write"), true);
  assert.equal(canAccessResource(authority, { personalOwnerId: human, personalOwnerType: "agent" }), false);
});
test("invalid mixed and unmapped owner scopes are denied", () => {
  assert.equal(canAccessResource(authority, { projectId: project, personalOwnerId: human, personalOwnerType: "human" }), false);
  assert.equal(canAccessResource(authority, { personalOwnerId: human }), false);
  assert.equal(canAccessResource(authority, { personalOwnerType: "human" }), false);
});
test("query predicates use the action ceiling before counting or pagination", () => {
  const dialect = new PgDialect();
  const read = dialect.sqlToQuery(resourcePredicate(authority, documents));
  const write = dialect.sqlToQuery(resourcePredicate(authority, documents, "resource.write"));
  assert.ok(read.params.includes(project));
  assert.ok(read.params.includes(human));
  assert.ok(!read.params.includes(other));
  assert.ok(!write.params.includes(project));
  assert.ok(write.params.includes(human));
  assert.match(read.sql, /is null/);
  assert.match(dialect.sqlToQuery(projectPredicate({ ...authority, grants: [] })).sql, /false/);
  assert.equal(dialect.sqlToQuery(resourcePredicate({ ...authority, grants: [] }, { projectId: projects.id })).sql, "false");
});
test("legacy package namespaces cannot read or write without a verified factory", async () => {
  await assert.rejects(projectService.getProject({} as never, project), AuthorizationError);
  await assert.rejects(taskService.getTask({} as never, project), AuthorizationError);
  await assert.rejects(documentService.listDocuments({} as never, { includeGlobal: true, includePersonal: false }), AuthorizationError);
  await assert.rejects(createResourceServices(undefined as never).projectService.getProject({} as never, project), AuthorizationError);
});
