import assert from "node:assert/strict";
import test from "node:test";
import { assistantPageContext } from "./assistant-page-context";

test("page Chat follows project navigation and returns to global outside a project", () => {
  const id = "88f0fae1-2f29-4073-92b8-c6ca71a85907";
  for (const route of [`/projects/${id}`, `/projects/${id}/schedules`]) {
    assert.deepEqual(assistantPageContext(route), { contextKind: "project", projectId: id });
  }
  for (const route of ["/projects", "/projects/new", "/projects/personal", "/projects/documents"]) {
    assert.deepEqual(assistantPageContext(route), { contextKind: "global" });
  }
});

test("requirement pages select the requirement instead of only the project", () => {
  const projectId = "88f0fae1-2f29-4073-92b8-c6ca71a85907";
  const requirementId = "47125ac7-9c02-4676-9754-6d8d9048b22e";
  assert.deepEqual(assistantPageContext(`/projects/${projectId}/requirements/${requirementId}`), { contextKind: "requirement", projectId, requirementId });
});
