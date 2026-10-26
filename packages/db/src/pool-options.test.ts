import assert from "node:assert/strict";
import test from "node:test";
import { databasePoolOptions } from "./pool-options";

test("database pool caps preserve the default and permit explicit reductions only", () => {
  assert.deepEqual(databasePoolOptions({}), { maxConnections: 10 });
  for (const value of ["1", "4", "10"]) assert.deepEqual(databasePoolOptions({ TW_DATABASE_POOL_MAX: value }), { maxConnections: Number(value) });
  for (const value of ["", "0", "11", "-1", "1.5", "1e1", " 2 ", "private-value"]) {
    assert.throws(() => databasePoolOptions({ TW_DATABASE_POOL_MAX: value }), error =>
      error instanceof Error && error.message === "TW_DATABASE_POOL_MAX must be an integer between 1 and 10");
  }
});
