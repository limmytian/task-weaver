import assert from "node:assert/strict";
import test from "node:test";
import { resourceAccessLost } from "./resource-access";

test("only typed server denials hide cached details,not transient refresh failures", () => {
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]) assert.equal(resourceAccessLost({ data: { code } }), true);
  for (const error of [null, new Error("NOT_FOUND"), { data: { code: "INTERNAL_SERVER_ERROR" } }, { data: { code: "CONFLICT" } }]) {
    assert.equal(resourceAccessLost(error), false);
  }
});
