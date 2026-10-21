import assert from "node:assert/strict";
import test from "node:test";
import { createInboundSourceSchema, inboundActionSchema, inboundRuleSchema } from "@task-weaver/contracts";
import { inboundPath, inboundTemplate } from "./inbound-events";

test("inbound paths never traverse prototypes and templates substitute scalars without evaluation", () => {
  assert.equal(inboundPath({ data: {} }, "data.constructor"), undefined);
  assert.equal(inboundPath({ data: {} }, "data.__proto__"), undefined);
  const event = { eventId: "proof", type: "build", data: { title: "$(touch /tmp/not-executed)", object: { value: 1 } } };
  assert.equal(inboundTemplate("Build {{data.title}}", event), "Build $(touch /tmp/not-executed)");
  assert.throws(() => inboundTemplate("{{data.object}}", event));
  assert.throws(() => inboundTemplate("{{data.missing}}", event));
  assert.throws(() => inboundTemplate("{{data.title}}", event, 2));
});

test("inbound rules cannot upload code, change ownership or omit project and requirement", () => {
  assert.equal(inboundActionSchema.safeParse({ type: "execute", code: "doAnything()" }).success, false);
  assert.equal(inboundActionSchema.safeParse({ type: "create_task", title: "Proof", projectId: "forged" }).success, false);
  assert.equal(inboundActionSchema.safeParse({ type: "update_task", target: { taskIdPath: "data.id" }, changes: { assignee: "forged" } }).success, false);
  assert.equal(createInboundSourceSchema.safeParse({ name: "Unscoped", rules: [] }).success, false);
  assert.equal(inboundRuleSchema.safeParse({ id: "11111111-1111-4111-8111-111111111111", eventTypes: ["build"],
    actions: [{ type: "add_comment", target: { taskIdPath: "data.__proto__.id" }, content: "Proof" }] }).success, false);
});
