import assert from "node:assert/strict";
import test from "node:test";
import { performanceBuildDirectory } from "./performance-build-directory";

test("performance builds preserve the default output and refuse destructive directory targets", () => {
  assert.equal(performanceBuildDirectory(undefined), ".next");
  assert.equal(performanceBuildDirectory(".next-perf-medium-a1"), ".next-perf-medium-a1");
  for (const path of ["", ".", "..", ".next", "/tmp/test", "../.next", ".next-perf-../data", "public", "src"]) {
    assert.throws(() => performanceBuildDirectory(path));
  }
});
