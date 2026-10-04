import assert from "node:assert";
import { test } from "node:test";
import { computeNextRunAt, planDueOccurrences } from "./schedules";

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    projectId: "00000000-0000-4000-8000-000000000001",
    requirementId: "00000000-0000-4000-8000-000000000002",
    targetScope: "project",
    kind: "recurring",
    title: "Daily schedule",
    description: null,
    status: "active",
    timezone: "UTC",
    startsAt: new Date("2026-06-28T00:00:00.000Z"),
    endsAt: null,
    nextRunAt: new Date("2026-06-28T00:00:00.000Z"),
    recurrenceSyntax: "rrule",
    recurrenceRule: "FREQ=DAILY;INTERVAL=1",
    catchUpPolicy: "latest",
    expiryWindowMinutes: null,
    maxCatchUpRuns: null,
    taskTitle: "Generated task",
    taskDescription: null,
    taskPriority: "medium",
    autoRun: false,
    assignedExecutor: null,
    assignedExecutorType: null,
    requestedProvider: null,
    requestedModel: null,
    createdBy: "tester",
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    ...overrides,
  } as any;
}

test("schedule recurrence calculation", async (t) => {
  await t.test("advances simple RRULE intervals", () => {
    const next = computeNextRunAt(schedule(), new Date("2026-06-28T00:00:00.000Z"));
    assert.equal(next?.toISOString(), "2026-06-29T00:00:00.000Z");
  });

  await t.test("advances simple cron minute intervals", () => {
    const next = computeNextRunAt(
      schedule({ recurrenceSyntax: "cron", recurrenceRule: "*/15 * * * *" }),
      new Date("2026-06-28T00:00:00.000Z"),
    );
    assert.equal(next?.toISOString(), "2026-06-28T00:15:00.000Z");
  });
});

test("schedule catch-up planning", async (t) => {
  await t.test("latest policy creates only the newest missed occurrence", () => {
    const plan = planDueOccurrences(schedule(), new Date("2026-06-30T00:00:00.000Z"));
    assert.deepEqual(plan.create.map((date) => date.toISOString()), ["2026-06-30T00:00:00.000Z"]);
    assert.deepEqual(plan.skip.map((date) => date.toISOString()), [
      "2026-06-28T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    ]);
    assert.equal(plan.nextRunAt?.toISOString(), "2026-07-01T00:00:00.000Z");
  });

  await t.test("all policy honors max catch-up runs", () => {
    const plan = planDueOccurrences(
      schedule({ catchUpPolicy: "all", maxCatchUpRuns: 2 }),
      new Date("2026-07-01T00:00:00.000Z"),
    );
    assert.deepEqual(plan.create.map((date) => date.toISOString()), [
      "2026-06-30T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ]);
    assert.deepEqual(plan.skip.map((date) => date.toISOString()), [
      "2026-06-28T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    ]);
  });

  await t.test("expiry window skips stale occurrences", () => {
    const plan = planDueOccurrences(
      schedule({ catchUpPolicy: "all", expiryWindowMinutes: 60 * 24 }),
      new Date("2026-07-01T00:00:00.000Z"),
    );
    assert.deepEqual(plan.create.map((date) => date.toISOString()), [
      "2026-06-30T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ]);
    assert.deepEqual(plan.skip.map((date) => date.toISOString()), [
      "2026-06-28T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    ]);
  });
});
