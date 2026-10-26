import assert from "node:assert/strict";
import test from "node:test";
import { performancePlanShape } from "./performance-authorized-plans";

test("authorized plan selection labels only known read shapes and excludes locking queries", () => {
  assert.equal(performancePlanShape('select jsonb_agg(x) from "tasks"'), "healthTasks");
  assert.equal(performancePlanShape('select count(*)::int from "activity_log" where x = $1'), "healthActivity");
  assert.equal(performancePlanShape('select count(*)::int from "tasks" where x = $1'), "tasksCount");
  assert.equal(performancePlanShape('select "id" from "tasks" order by "tasks"."updated_at" desc limit $1'), "tasksPage");
  assert.equal(performancePlanShape('select count(*)::int from "requirements" where exists (select 1 from "tasks")'), "requirementsCount");
  for (const text of ['select "secret" from "api_keys"', 'select jsonb_agg(x) from "tasks" for update',
    'select count(*) from "tasks" for no key update']) assert.equal(performancePlanShape(text), undefined);
});
