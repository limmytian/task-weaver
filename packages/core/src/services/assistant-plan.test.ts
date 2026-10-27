import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAssistantOperation } from "./assistant-operations";
import type { createResourceServices } from "./resource-services";
import type { Database } from "@task-weaver/db";

const projectId = "00000000-0000-4000-8000-000000000001";
const draftId = "00000000-0000-4000-8000-000000000002";
test("assistant staging creates a draft reference without applying a plan", async () => {
  let source = "";
  const services = { planService: { createPlanDraft: async (_db: unknown, input: { source: string }) => { source = input.source; return { projectId, id: draftId, revision: 1 }; } } } as unknown as ReturnType<typeof createResourceServices>;
  const result = await executeAssistantOperation({} as Database, services, "stage_plan", { plan: { projectId, requirements: [{ key: "r", title: "Draft" }] } }, { id: "actor", type: "human" });
  assert.equal(source, "assistant");
  assert.equal(result.entityId, projectId);
  assert.equal(result.result.webPath, `/projects/${projectId}/plans/${draftId}`);
  await assert.rejects(executeAssistantOperation({} as Database, services, "stage_plan", { plan: { projectId, requirements: [{ key: "r", title: "Draft", status: "approved" }] } }, { id: "actor", type: "human" }));
});
