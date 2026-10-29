import { strict as assert } from "node:assert";
import { test } from "node:test";
import { latestRequirementReviewChecks, recordedReviewChecks } from "./review-checks";

test("unrecorded checks remain absent instead of being reported as failed", () => {
  assert.deepEqual(recordedReviewChecks(["build", "security", "review"], {
    build: "passed", security: "failed", obsolete: "passed",
  }), [{ name: "build", status: "passed" }, { name: "security", status: "failed" }]);
});

test("latest requirement acceptance exposes configured checks without inventing results", () => {
  const result = latestRequirementReviewChecks(["build", "security"], [
    { stage: "integration", checks: [{ name: "build", status: "passed" }] },
    { stage: "acceptance", decision: "changes_requested", actorId: "reviewer", checks: [{ name: "build", status: "passed" }] },
  ]);

  assert.deepEqual(result.checks, [
    { name: "build", status: "passed" },
    { name: "security", status: "not_recorded" },
  ]);
  assert.equal(result.record?.decision, "changes_requested");
});

test("requirement acceptance checks remain not recorded without an acceptance activity", () => {
  assert.deepEqual(latestRequirementReviewChecks(["build"], [{ stage: "delivery", checks: [{ name: "build", status: "passed" }] }]).checks, [
    { name: "build", status: "not_recorded" },
  ]);
});
