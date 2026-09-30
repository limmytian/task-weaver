import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "@task-weaver/contracts";
import { assertExecutionSliceCanAdvance } from "./execution-slice-policy";

function policyDb(slice: Record<string, unknown>, earlierSlices: Record<string, unknown>[]) {
  return {
    query: {
      executionSlices: {
        findFirst: async () => slice,
        findMany: async () => earlierSlices,
      },
    },
  };
}

test("sequential execution slices cannot advance past an earlier nonterminal slice", async () => {
  const db = policyDb({
    id: "slice-2",
    requirementId: "req-1",
    title: "Second",
    orderIndex: 1,
    allowParallel: false,
  }, [{ title: "First", status: "in_progress", orderIndex: 0 }]);

  await assert.rejects(
    () => assertExecutionSliceCanAdvance(db as any, "slice-2"),
    (error: unknown) => error instanceof ValidationError
      && /First.*in_progress/.test(error.message),
  );
});

test("explicitly parallel slices may advance while earlier slices remain active", async () => {
  let queriedEarlierSlices = false;
  const db = policyDb({
    id: "slice-2",
    requirementId: "req-1",
    title: "Second",
    orderIndex: 1,
    allowParallel: true,
  }, []);
  db.query.executionSlices.findMany = async () => {
    queriedEarlierSlices = true;
    return [];
  };

  await assertExecutionSliceCanAdvance(db as any, "slice-2");
  assert.equal(queriedEarlierSlices, false);
});
