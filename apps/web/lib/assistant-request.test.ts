import assert from "node:assert/strict";
import test from "node:test";
import { canRecoverAssistantRequest, recoverAssistantRequest } from "./assistant-request";

test("transport failures recover the original result without submitting another operation", async () => {
  let reads = 0;
  const result = await recoverAssistantRequest(async () => ++reads < 3
    ? { status: "running", result: null }
    : { status: "completed", result: { actionId: "persisted-action" } }, async () => {}, 4);
  assert.deepEqual(result, { actionId: "persisted-action" });
  assert.equal(reads, 3);
  assert.equal(canRecoverAssistantRequest({ data: { httpStatus: 504 } }), true);
});

test("authorization failures and terminal failed requests stop recovery", async () => {
  for (const httpStatus of [400, 401, 403, 404]) {
    assert.equal(canRecoverAssistantRequest({ data: { httpStatus } }), false);
    let reads = 0;
    assert.equal(await recoverAssistantRequest(async () => { reads++; throw { data: { httpStatus } }; }, async () => {}, 4), null);
    assert.equal(reads, 1);
  }
  assert.equal(await recoverAssistantRequest(async () => ({ status: "failed", result: null }), async () => { throw new Error("Must not retry a failed request"); }), null);
});
