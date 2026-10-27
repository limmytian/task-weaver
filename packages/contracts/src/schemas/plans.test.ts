import assert from "node:assert";
import { test } from "node:test";
import { planSchema } from "./plans";

const projectId = "00000000-0000-4000-8000-000000000001";

test("plan schema accepts a complete requirement planning batch", () => {
  const result = planSchema.safeParse({
    projectId,
    documents: [
      {
        key: "auth-design",
        title: "Auth Design",
        content: "# Auth Design",
        docType: "design",
      },
    ],
    requirements: [
      {
        key: "auth-api",
        title: "Auth API",
        status: "approved",
        priority: "high",
        modelTier: "strong",
        documents: [{ document: "auth-design", type: "documents" }],
        slices: [{ key: "schema", title: "Schema", tasks: ["auth-db"] }],
        tasks: [
          {
            key: "auth-db",
            title: "Add auth tables",
            comments: ["Planning: start with schema."],
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.requirements[0]?.tasks[0]?.status, "todo");
    assert.equal(result.data.requirements[0]?.tasks[0]?.priority, "medium");
    assert.equal(result.data.requirements[0]?.slices[0]?.tasks[0], "auth-db");
  }
});

test("plan schema requires creation fields for new entities", () => {
  const result = planSchema.safeParse({
    projectId,
    documents: [{ key: "missing-content", title: "Missing Content" }],
    requirements: [{ key: "missing-title" }],
  });

  assert.equal(result.success, false);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    assert.ok(errors.documents);
    assert.ok(errors.requirements);
  }
});

test("staging enforces bounds and does not schedule newly created work", async () => {
  const { stagedPlanSchema } = await import("./plans");
  const projectId = "00000000-0000-4000-8000-000000000001";
  assert.equal(stagedPlanSchema.safeParse({ projectId, requirements: [{ key: "r", title: "R", status: "approved" }] }).success, false);
  assert.equal(stagedPlanSchema.safeParse({ projectId, requirements: [{ key: "r", title: "R", tasks: [{ key: "t", title: "T", status: "in_progress" }] }] }).success, false);
  assert.equal(stagedPlanSchema.safeParse({ projectId, documents: [{ key: "d", title: "D", content: "x".repeat(1024 * 1024) }] }).success, false);
  assert.equal(stagedPlanSchema.safeParse({ projectId, requirements: [{ key: "r", title: "R", tasks: Array.from({ length: 201 }, (_, i) => ({ key: `t${i}`, title: "T" })) }] }).success, false);
});
