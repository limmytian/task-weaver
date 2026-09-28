import assert from "node:assert";
import { test } from "node:test";
import { createScheduleSchema } from "./schedules";

const projectId = "00000000-0000-4000-8000-000000000001";
const requirementId = "00000000-0000-4000-8000-000000000002";

test("schedule schemas", async (t) => {
  await t.test("requires recurrence details for recurring schedules", () => {
    const result = createScheduleSchema.safeParse({
      projectId,
      requirementId,
      targetScope: "project",
      kind: "recurring",
      title: "Daily summary",
      startsAt: "2026-06-28T00:00:00.000Z",
      taskTemplate: { title: "Write daily summary" },
    });

    assert.equal(result.success, false);
  });

  await t.test("accepts catch-up and expiry controls", () => {
    const result = createScheduleSchema.safeParse({
      projectId,
      requirementId,
      targetScope: "project",
      kind: "recurring",
      title: "Daily summary",
      startsAt: "2026-06-28T00:00:00.000Z",
      recurrenceSyntax: "rrule",
      recurrenceRule: "FREQ=DAILY;INTERVAL=1",
      catchUpPolicy: "all",
      expiryWindowMinutes: 1440,
      maxCatchUpRuns: 3,
      taskTemplate: { title: "Write daily summary" },
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.catchUpPolicy, "all");
      assert.equal(result.data.expiryWindowMinutes, 1440);
      assert.equal(result.data.maxCatchUpRuns, 3);
    }
  });
});
