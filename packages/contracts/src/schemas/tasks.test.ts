import { test } from "node:test";
import assert from "node:assert";
import { createPersonalTaskSchema, createTaskSchema, listTasksSchema } from "./tasks.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const requirementId = "00000000-0000-4000-8000-000000000002";

test("task scope schemas", async (t) => {
  await t.test("project task still requires a requirement", () => {
    const result = createTaskSchema.safeParse({
      projectId,
      title: "Project task",
    });

    assert.equal(result.success, false);
  });

  await t.test("personal task does not require project or requirement", () => {
    const result = createPersonalTaskSchema.safeParse({
      title: "Buy coffee",
      priority: "low",
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.title, "Buy coffee");
      assert.equal(result.data.priority, "low");
    }
  });

  await t.test("personal scoped task rejects project ownership", () => {
    const result = createTaskSchema.safeParse({
      scope: "personal",
      projectId,
      requirementId,
      title: "Invalid personal task",
    });

    assert.equal(result.success, false);
  });

  await t.test("personal task listing accepts owner filters", () => {
    const result = listTasksSchema.safeParse({
      scope: "personal",
      personalOwnerId: "user:mini",
      personalOwnerType: "human",
    });

    assert.equal(result.success, true);
  });
});
