import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationDeniedError,
  EntitlementDeniedError,
  enforceAccess,
  type AuditEvent,
  type AuditPort,
} from "./ports";

const actor = { id: "user-1", type: "human" } as const;

function auditCollector(events: AuditEvent[]): AuditPort {
  return { record: (event) => { events.push(event); } };
}

test("enforces authorization on the server and audits denial", async () => {
  const events: AuditEvent[] = [];
  await assert.rejects(
    enforceAccess({
      authorization: { authorize: () => ({ allowed: false, reason: "Project access denied", policy: "test" }) },
      entitlements: { checkEntitlement: () => ({ allowed: true }) },
      audit: auditCollector(events),
    }, {
      authorization: { actor, permission: "project.write", resource: { type: "project", id: "p1" } },
    }),
    (error: unknown) => error instanceof AuthorizationDeniedError && error.status === 403,
  );
  assert.equal(events[0]?.outcome, "denied");
  assert.equal(events[0]?.action, "project.write");
});

test("enforces entitlements independently from authorization and UI visibility", async () => {
  const events: AuditEvent[] = [];
  await assert.rejects(
    enforceAccess({
      authorization: { authorize: () => ({ allowed: true }) },
      entitlements: { checkEntitlement: () => ({ allowed: false, reason: "Capability unavailable" }) },
      audit: auditCollector(events),
    }, {
      authorization: { actor, permission: "project.read" },
      entitlement: { capability: "analytics.read" },
    }),
    (error: unknown) => error instanceof EntitlementDeniedError && error.status === 403,
  );
  assert.equal(events[0]?.action, "entitlement:analytics.read");
});

test("allows requests only after both decisions pass", async () => {
  await enforceAccess({
    authorization: { authorize: () => ({ allowed: true }) },
    entitlements: { checkEntitlement: () => ({ allowed: true }) },
    audit: { record: () => undefined },
  }, {
    authorization: { actor, permission: "project.read" },
    entitlement: { capability: "projects" },
  });
});
