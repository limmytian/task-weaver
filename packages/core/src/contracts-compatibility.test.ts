import assert from "node:assert/strict";
import test from "node:test";
import {
  NotFoundError as ContractNotFoundError,
  realtimeEventSchema as contractRealtimeEventSchema,
  taskStatusSchema as contractTaskStatusSchema,
} from "@task-weaver/contracts";
import {
  NotFoundError,
  realtimeEventSchema,
  taskStatusSchema,
} from "./index";

test("keeps the historical Core contract exports as compatibility aliases", () => {
  assert.equal(taskStatusSchema, contractTaskStatusSchema);
  assert.equal(realtimeEventSchema, contractRealtimeEventSchema);
  assert.equal(NotFoundError, ContractNotFoundError);
});
