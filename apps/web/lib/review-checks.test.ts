import { strict as assert } from "node:assert";
import { test } from "node:test";
import { recordedReviewChecks } from "./review-checks";

test("unrecorded checks remain absent instead of being reported as failed", () => {
  assert.deepEqual(recordedReviewChecks(["build", "security", "review"], {
    build: "passed", security: "failed", obsolete: "passed",
  }), [{ name: "build", status: "passed" }, { name: "security", status: "failed" }]);
});
