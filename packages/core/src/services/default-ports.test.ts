import assert from "node:assert/strict";
import test from "node:test";
import { enforceAccess } from "@task-weaver/module-sdk/ports";
import {
  BufferedAuditPort,
  EnvironmentSecretStorePort,
  InMemoryMeteringPort,
  LocalNotificationPort,
  SecretReferenceError,
  SingleInstanceIdentityPort,
  createDefaultRuntimePorts,
} from "./default-ports";

test("single-instance identity preserves current header defaults", () => {
  const identity = new SingleInstanceIdentityPort();
  assert.deepEqual(identity.resolveIdentity({ headers: {} }), {
    actor: { id: "anonymous", type: "human" },
    authenticated: false,
    authenticationMethod: "anonymous",
  });
  assert.equal(identity.resolveIdentity({
    headers: { "x-actor-id": "agent-1", "x-actor-type": "agent" },
  }).actor.type, "agent");
  assert.equal(identity.resolveIdentity({
    headers: {}, existingActor: { id: "api-key", type: "agent" },
  }).actor.id, "api-key");
});

test("environment secret store resolves references without exposing values in errors", () => {
  const secrets = new EnvironmentSecretStorePort({ SERVICE_TOKEN: "sensitive-value" });
  assert.equal(secrets.resolveSecret({ reference: "env:SERVICE_TOKEN", purpose: "test" }), "sensitive-value");
  assert.throws(
    () => secrets.resolveSecret({ reference: "literal-secret", purpose: "test" }),
    SecretReferenceError,
  );
  assert.throws(
    () => secrets.resolveSecret({ reference: "env:MISSING_TOKEN", purpose: "test" }),
    (error: unknown) => error instanceof Error && !error.message.includes("sensitive-value"),
  );
});

test("local audit, notification, and metering defaults are bounded and inspectable", async () => {
  const audit = new BufferedAuditPort(1);
  const notifications = new LocalNotificationPort(1);
  const metering = new InMemoryMeteringPort(2);
  const actor = { id: "user-1", type: "human" } as const;

  audit.record({ action: "first", actor, occurredAt: new Date().toISOString(), outcome: "success" });
  audit.record({ action: "second", actor, occurredAt: new Date().toISOString(), outcome: "success" });
  assert.deepEqual(audit.events().map((event) => event.action), ["second"]);

  const result = await notifications.send({ topic: "task", title: "Done", body: "Task completed" });
  assert.equal(result.accepted, true);
  assert.equal(notifications.messages()[0]?.message.topic, "task");

  metering.recordUsage({ metric: "requests", quantity: 2, occurredAt: new Date().toISOString() });
  metering.recordUsage({ metric: "requests", quantity: 3, occurredAt: new Date().toISOString() });
  assert.equal(metering.total("requests"), 5);
  assert.throws(
    () => metering.recordUsage({ metric: "requests", quantity: -1, occurredAt: new Date().toISOString() }),
    /finite non-negative/,
  );
});

test("complete defaults preserve permissive single-instance access", async () => {
  const ports = createDefaultRuntimePorts({ environment: { TOKEN: "value" } });
  const identity = await ports.identity.resolveIdentity({ headers: {} });
  await enforceAccess(ports, {
    authorization: { actor: identity.actor, permission: "projects.read" },
    entitlement: { capability: "projects" },
  });
  assert.equal(await ports.secrets.resolveSecret({ reference: "env:TOKEN", purpose: "test" }), "value");
});
