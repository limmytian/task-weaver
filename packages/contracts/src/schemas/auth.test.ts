import assert from "node:assert/strict";
import test from "node:test";
import {
  accountDtoSchema, apiKeyDtoSchema, authErrorDtoSchema, authorizationGrantSchema,
  credentialGrantsSchema, issueScopedApiKeySchema, principalSchema, PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_GRANTABLE_PERMISSIONS,
  projectMembershipDtoSchema, requestIdentitySnapshotSchema, sessionDtoSchema,
  type RequestIdentitySnapshot, type VerifiedRequestContext,
} from "./auth";
import { AuthenticationError, AuthorizationError } from "../errors";

const actorId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const keyId = "00000000-0000-4000-8000-000000000003";
const projectId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000005";
const createdAt = "2026-10-05T09:00:00Z";
const expiresAt = "2026-10-05T10:00:00Z";
const human = { id: actorId, type: "human", userId, status: "active", instanceRole: "user" } as const;
const agent = { id: actorId, type: "agent", managedByActorId: userId, status: "active" } as const;
const grants = [{ scope: "project", projectId, permissions: ["resource.read", "execution.run"] }] as const;
const keyContext = {
  actor: human,
  credential: { kind: "api_key", id: keyId, actorId, expiresAt, grants },
  verifiedAt: createdAt,
};
const delegationContext = {
  actor: agent,
  credential: {
    kind: "delegation", id: keyId, actorId, expiresAt, grants,
    delegation: {
      id: otherId, parentCredentialId: userId, delegatorActorId: userId,
      initiator: { id: userId, type: "human" }, executorActorId: actorId,
      projectId, requirementId: otherId, taskIds: [keyId], repositoryIds: [],
      runId: otherId, purpose: "execute", leaseGeneration: 1, expiresAt,
    },
  },
  verifiedAt: createdAt,
};

test("credential rotation preserves a human principal and human CLI identity", () => {
  const first = requestIdentitySnapshotSchema.parse(keyContext);
  const rotated = requestIdentitySnapshotSchema.parse({
    ...keyContext, credential: { ...keyContext.credential, id: otherId },
  });
  assert.deepEqual(first.actor, rotated.actor);
  assert.equal(rotated.actor.type, "human");
  assert.notEqual(first.credential.id, rotated.credential.id);
  assert.equal(requestIdentitySnapshotSchema.safeParse({ ...keyContext, actor: agent }).success, true);
});

test("caller headers, anonymous identities and credential IDs cannot authenticate", () => {
  for (const input of [
    { "x-actor-id": actorId, "x-actor-type": "human" },
    { ...keyContext, "x-actor-id": otherId },
    { ...keyContext, actor: { ...human, id: "anonymous" } },
    { ...keyContext, actor: { ...human, id: `apikey:${keyId}` } },
    { ...keyContext, credential: { ...keyContext.credential, actorId: otherId } },
    { ...keyContext, actor: { ...human, status: "disabled" } },
    { ...keyContext, actor: { ...agent, instanceRole: "admin" } },
  ]) assert.equal(requestIdentitySnapshotSchema.safeParse(input).success, false);
});

test("browser session requires a live human subject; parsing does not attest verification", () => {
  const context = { ...keyContext, credential: { kind: "session", id: keyId, actorId, expiresAt } };
  assert.equal(requestIdentitySnapshotSchema.safeParse(context).success, true);
  assert.equal(requestIdentitySnapshotSchema.safeParse({ ...context, actor: agent }).success, false);
  for (const deadline of [createdAt, "2026-10-05T08:00:00Z", "invalid-date"]) {
    assert.equal(requestIdentitySnapshotSchema.safeParse({
      ...context, credential: { ...context.credential, expiresAt: deadline },
    }).success, false);
  }
  const snapshot: RequestIdentitySnapshot = requestIdentitySnapshotSchema.parse(context);
  // @ts-expect-error A structurally valid snapshot is not a server-verified context.
  const verified: VerifiedRequestContext = snapshot;
  void verified;
});

test("strict grants reject wildcard and ambiguous resource selectors", () => {
  for (const input of [
    { scope: "project", permissions: ["resource.read"] },
    { scope: "project", projectId, permissions: ["*"] },
    { scope: "project", projectId, permissions: ["instance.manage"] },
    { scope: "personal", actorId, permissions: ["project.members.manage"] },
    { scope: "instance", permissions: ["resource.read"] },
    { scope: "project", projectId, actorId, permissions: ["resource.read"] },
    { scope: "personal", permissions: ["resource.read"] },
    { scope: "global", projectId, permissions: ["resource.read"] },
    { scope: "tenant", permissions: ["resource.read"] },
    { scope: "project", projectId, permissions: ["resource.read", "resource.read"] },
  ]) assert.equal(authorizationGrantSchema.safeParse(input).success, false);
  assert.equal(credentialGrantsSchema.safeParse([]).success, false);
  assert.equal(issueScopedApiKeySchema.safeParse({ name: "CLI", grants, expiresAt, actorId }).success, false);
  assert.equal(issueScopedApiKeySchema.safeParse({ name: "CLI", grants, expiresAt }).success, true);
});

test("delegation is bounded to one project, an agent, tasks, purpose and lease", () => {
  assert.equal(requestIdentitySnapshotSchema.safeParse(delegationContext).success, true);
  const credential = delegationContext.credential;
  const delegation = credential.delegation;
  for (const changed of [
    { ...credential, grants: [{ scope: "global", permissions: ["resource.read"] }] },
    { ...credential, grants: [{ ...grants[0], projectId: otherId }] },
    { ...credential, grants: [{ ...grants[0], permissions: ["project.members.manage"] }] },
    { ...credential, grants: [{ ...grants[0], permissions: ["execution.merge"] }] },
    { ...credential, delegation: { ...delegation, taskIds: [] } },
    { ...credential, delegation: { ...delegation, taskIds: [keyId, keyId] } },
    { ...credential, delegation: { ...delegation, leaseGeneration: 0 } },
    { ...credential, delegation: { ...delegation, leaseGeneration: undefined } },
    { ...credential, delegation: { ...delegation, executorActorId: otherId } },
    { ...credential, delegation: { ...delegation, expiresAt: createdAt } },
  ]) {
    assert.equal(requestIdentitySnapshotSchema.safeParse({ ...delegationContext, credential: changed }).success, false);
  }
  assert.equal(requestIdentitySnapshotSchema.safeParse({ ...delegationContext, actor: human }).success, false);
});

test("review and merge grants preserve phase separation and task bookkeeping", () => {
  for (const purpose of ["review", "merge"] as const) {
    const input = {
      ...delegationContext,
      credential: {
        ...delegationContext.credential,
        grants: [{ scope: "project", projectId, permissions: ["resource.read", "resource.write", `execution.${purpose}`] }],
        delegation: { ...delegationContext.credential.delegation, purpose },
      },
    };
    assert.equal(requestIdentitySnapshotSchema.safeParse(input).success, true);
    assert.equal(requestIdentitySnapshotSchema.safeParse({
      ...input, credential: { ...input.credential, grants },
    }).success, false);
  }
});

test("public credential/account metadata rejects secrets rather than silently exposing them", () => {
  const account = { id: userId, actorId, email: "user@example.com", displayName: "User", status: "active", instanceRole: "user", createdAt };
  const session = { id: keyId, actorId, createdAt, expiresAt, lastSeenAt: null, revokedAt: null };
  const key = { id: keyId, actorId, issuedByActorId: actorId, name: "CLI", prefix: "tw_key", grants, createdAt, expiresAt, lastUsedAt: null, revokedAt: null };
  const entries = [[accountDtoSchema, account], [sessionDtoSchema, session], [apiKeyDtoSchema, key], [principalSchema, human]] as const;
  for (const [schema, data] of entries) {
    assert.equal(schema.safeParse(data).success, true);
    for (const field of ["token", "tokenHash", "keyHash", "password", "passwordHash", "secret"]) {
      assert.equal(schema.safeParse({ ...data, [field]: "sensitive" }).success, false);
    }
  }
});

test("project roles do not imply tool calls, review, merge or instance authority", () => {
  for (const role of Object.keys(PROJECT_ROLE_PERMISSIONS) as (keyof typeof PROJECT_ROLE_PERMISSIONS)[]) {
    const permissions: readonly string[] = PROJECT_ROLE_PERMISSIONS[role];
    for (const sensitive of ["execution.review", "execution.merge", "mcp.invoke", "instance.manage", "global.manage"]) {
      assert.equal(permissions.includes(sensitive), false);
    }
  }
  assert.equal(PROJECT_ROLE_PERMISSIONS.owner.includes("project.ownership.manage"), true);
  assert.equal((PROJECT_ROLE_PERMISSIONS.maintainer as readonly string[]).includes("project.ownership.manage"), false);
  const membership = { id: keyId, projectId, actor: { id: actorId, type: "agent" }, role: "member", explicitPermissions: ["execution.run"], createdAt };
  assert.equal(projectMembershipDtoSchema.safeParse(membership).success, true);
  assert.equal(projectMembershipDtoSchema.safeParse({ ...membership, role: "admin" }).success, false);
  assert.equal(projectMembershipDtoSchema.safeParse({ ...membership, explicitPermissions: ["instance.manage"] }).success, false);
  assert.equal(projectMembershipDtoSchema.safeParse({ ...membership, explicitPermissions: ["execution.run", "execution.run"] }).success, false);
  assert.equal(PROJECT_ROLE_GRANTABLE_PERMISSIONS.member.length, 0);
  assert.equal(PROJECT_ROLE_GRANTABLE_PERMISSIONS.owner.includes("execution.merge"), true);
});

test("authentication and authorization errors share safe messages and stable codes", () => {
  const authentication = new AuthenticationError("principal_disabled");
  const authorization = new AuthorizationError("csrf_rejected");
  assert.equal(authentication.message, new AuthenticationError("invalid_credential").message);
  assert.deepEqual(authErrorDtoSchema.parse({ error: authentication.message, code: "authentication_required" }), {
    error: "Authentication required", code: "authentication_required",
  });
  assert.equal(authorization.code, "csrf_rejected");
  assert.equal(authorization.message, "Access denied");
});
