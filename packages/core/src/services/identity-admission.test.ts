import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@task-weaver/db";
import { AuthenticationError } from "@task-weaver/contracts";
import { createIdentityManagementService } from "./identity-management";

test("rejected assignee credentials never reserve a transaction connection", async () => {
  let transactions = 0, resolutions = 0;
  const tx = { select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: "instance" }] }) }) }) };
  const db = { transaction: async (work: (connection: unknown) => Promise<unknown>) => {
    transactions++; return work(tx);
  } } as unknown as Database;
  const service = createIdentityManagementService(db, {
    assertMutation: () => { throw new Error("Assignee reads must not enter mutation authentication"); },
    resolve: async () => { resolutions++; throw new AuthenticationError("invalid_credential"); },
  });
  for (const projectId of [undefined, "00000000-0000-4000-8000-000000000001"]) {
    await assert.rejects(() => service.listAssignees(new Headers(), projectId), AuthenticationError);
  }
  assert.equal(resolutions, 2);
  assert.equal(transactions, 0);
});
