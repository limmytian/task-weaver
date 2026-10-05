import assert from "node:assert/strict";
import test from "node:test";
import {
  NotFoundError as ContractNotFoundError,
  AuthenticationError as ContractAuthenticationError,
  AuthorizationError as ContractAuthorizationError,
  principalSchema as contractPrincipalSchema,
  requestIdentitySnapshotSchema as contractIdentitySchema,
  realtimeEventSchema as contractRealtimeEventSchema,
  taskStatusSchema as contractTaskStatusSchema,
} from "@task-weaver/contracts";
import {
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  principalSchema,
  requestIdentitySnapshotSchema,
  realtimeEventSchema,
  taskStatusSchema,
} from "./index";

test("keeps the historical Core contract exports as compatibility aliases", () => {
  assert.equal(taskStatusSchema, contractTaskStatusSchema);
  assert.equal(realtimeEventSchema, contractRealtimeEventSchema);
  assert.equal(NotFoundError, ContractNotFoundError);
});

test("shares auth contracts and error identity across Core compatibility entry points", async () => {
  const schemas = await import("./schemas/index");
  assert.equal(principalSchema, contractPrincipalSchema);
  assert.equal(requestIdentitySnapshotSchema, contractIdentitySchema);
  assert.equal(schemas.requestIdentitySnapshotSchema, contractIdentitySchema);
  assert.equal(AuthenticationError, ContractAuthenticationError);
  assert.equal(AuthorizationError, ContractAuthorizationError);
  assert.ok(new AuthenticationError() instanceof ContractAuthenticationError);
});
