import { z } from "zod";

const idSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const uniqueIdsSchema = z
  .array(idSchema)
  .max(1000)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Duplicate resource IDs are not allowed",
  );

export const principalStatusSchema = z.enum(["active", "disabled"]);
export const instanceRoleSchema = z.enum(["user", "admin"]);
export const projectRoleSchema = z.enum([
  "owner",
  "maintainer",
  "member",
  "viewer",
]);
export const stableActorReferenceSchema = z
  .object({
    id: idSchema,
    type: z.enum(["human", "agent"]),
  })
  .strict();

const humanPrincipalSchema = z
  .object({
    id: idSchema,
    type: z.literal("human"),
    userId: idSchema,
    status: principalStatusSchema,
    instanceRole: instanceRoleSchema,
  })
  .strict();
const agentPrincipalSchema = z
  .object({
    id: idSchema,
    type: z.literal("agent"),
    managedByActorId: idSchema,
    status: principalStatusSchema,
  })
  .strict();

export const principalSchema = z.discriminatedUnion("type", [
  humanPrincipalSchema,
  agentPrincipalSchema,
]);
export const activePrincipalSchema = z.discriminatedUnion("type", [
  humanPrincipalSchema.extend({ status: z.literal("active") }),
  agentPrincipalSchema.extend({ status: z.literal("active") }),
]);

export const authorizationPermissionSchema = z.enum([
  "resource.read",
  "resource.write",
  "project.create",
  "project.manage",
  "project.members.manage",
  "project.ownership.manage",
  "agent.manage",
  "credential.manage",
  "mcp.manage",
  "mcp.invoke",
  "repository.manage",
  "execution.run",
  "execution.review",
  "execution.merge",
  "webhook.manage",
  "audit.read",
  "instance.manage",
  "global.manage",
]);
const permissionsSchema = z
  .array(authorizationPermissionSchema)
  .min(1)
  .max(100)
  .refine(
    (permissions) => new Set(permissions).size === permissions.length,
    "Duplicate permissions are not allowed",
  );

export const authorizationScopeSchema = z.enum([
  "personal",
  "project",
  "global",
  "instance",
]);
export const AUTHORIZATION_SCOPE_PERMISSIONS = {
  personal: [
    "resource.read",
    "resource.write",
    "credential.manage",
    "agent.manage",
    "mcp.manage",
    "mcp.invoke",
    "repository.manage",
  ],
  project: [
    "resource.read",
    "resource.write",
    "project.manage",
    "project.members.manage",
    "project.ownership.manage",
    "agent.manage",
    "mcp.manage",
    "mcp.invoke",
    "repository.manage",
    "execution.run",
    "execution.review",
    "execution.merge",
    "webhook.manage",
    "audit.read",
  ],
  global: [
    "resource.read",
    "resource.write",
    "global.manage",
    "mcp.manage",
    "mcp.invoke",
    "repository.manage",
    "webhook.manage",
  ],
  instance: ["instance.manage", "project.create", "agent.manage", "audit.read"],
} as const satisfies Readonly<
  Record<
    z.infer<typeof authorizationScopeSchema>,
    readonly AuthorizationPermission[]
  >
>;

const scopedPermissions = (scope: z.infer<typeof authorizationScopeSchema>) =>
  permissionsSchema.refine(
    (permissions) =>
      permissions.every((permission) =>
        (
          AUTHORIZATION_SCOPE_PERMISSIONS[
            scope
          ] as readonly AuthorizationPermission[]
        ).includes(permission),
      ),
    "Permission is not available for this resource scope",
  );

export const projectAuthorizationGrantSchema = z
  .object({
    scope: z.literal("project"),
    projectId: idSchema,
    permissions: scopedPermissions("project"),
  })
  .strict();

/** Requested grants are ceilings, never proof of ownership or authority. */
export const authorizationGrantSchema = z.discriminatedUnion("scope", [
  projectAuthorizationGrantSchema,
  z
    .object({
      scope: z.literal("personal"),
      actorId: idSchema,
      permissions: scopedPermissions("personal"),
    })
    .strict(),
  z
    .object({
      scope: z.literal("global"),
      permissions: scopedPermissions("global"),
    })
    .strict(),
  z
    .object({
      scope: z.literal("instance"),
      permissions: scopedPermissions("instance"),
    })
    .strict(),
]);
export const credentialGrantsSchema = z
  .array(authorizationGrantSchema)
  .min(1)
  .max(100);

/** Separately approved, persisted actor entitlements; token scopes alone cannot add these rights. */
export const explicitProjectPermissionSchema = z.enum([
  "execution.run",
  "execution.review",
  "execution.merge",
  "mcp.invoke",
]);
const explicitProjectPermissionsSchema = z
  .array(explicitProjectPermissionSchema)
  .max(4)
  .refine(
    (permissions) => new Set(permissions).size === permissions.length,
    "Duplicate explicit permissions are not allowed",
  );

export const projectMembershipDtoSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    actor: stableActorReferenceSchema,
    role: projectRoleSchema,
    explicitPermissions: explicitProjectPermissionsSchema,
    createdAt: timestampSchema,
  })
  .strict();
export const accountDtoSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    email: z.string().email().max(320),
    displayName: z.string().min(1).max(255),
    status: principalStatusSchema,
    instanceRole: instanceRoleSchema,
    createdAt: timestampSchema,
  })
  .strict();
export const sessionDtoSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    lastSeenAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
  })
  .strict();
export const apiKeyDtoSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    issuedByActorId: idSchema,
    name: z.string().trim().min(1).max(255),
    prefix: z.string().min(1).max(32),
    grantVersion: z.number().int().positive(),
    grants: credentialGrantsSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema.nullable(),
    lastUsedAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
  })
  .strict();

/** Subject comes from the verified self/managed-agent route, not this payload. */
export const issueScopedApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    grants: credentialGrantsSchema,
    // Explicit null selects no time-based expiry; omission must not do so implicitly.
    expiresAt: timestampSchema.nullable(),
  })
  .strict();
export const credentialSubjectSchema = z
  .object({ actorId: idSchema.optional() })
  .strict();
export const issueOwnedApiKeySchema = issueScopedApiKeySchema.extend({
  actorId: idSchema.optional(),
});
export const transferProjectOwnershipSchema = z
  .object({ actorId: idSchema })
  .strict();
export const accountLoginSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    // The server must validate this requested duration against configured session policy.
    sessionDurationSeconds: z.number().int().positive().safe().optional(),
    sessionIdleSeconds: z.number().int().positive().safe().optional(),
  })
  .strict();

const newPasswordSchema = z.string().min(12).max(128);
export const provisionAccountSchema = z
  .object({
    email: z
      .string()
      .email()
      .max(320)
      .transform((email) => email.toLowerCase()),
    displayName: z.string().trim().min(1).max(255),
  })
  .strict();
export const bootstrapAccountSchema = provisionAccountSchema
  .extend({
    bootstrapSecret: z.string().min(32).max(1024),
    password: newPasswordSchema,
  })
  .strict();
export const activateAccountSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    password: newPasswordSchema,
  })
  .strict();
export const changeAccountPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: newPasswordSchema,
  })
  .strict();
export const reauthenticateAccountSchema = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();

export const executionDelegationSchema = z
  .object({
    id: idSchema,
    parentCredentialId: idSchema,
    delegatorActorId: idSchema,
    initiator: stableActorReferenceSchema,
    executorActorId: idSchema,
    projectId: idSchema,
    requirementId: idSchema,
    taskIds: uniqueIdsSchema.refine(
      (ids) => ids.length > 0,
      "Delegation requires tasks",
    ),
    repositoryIds: uniqueIdsSchema,
    runId: idSchema,
    purpose: z.enum(["execute", "review", "merge", "automation"]),
    leaseGeneration: z.number().int().positive(),
    expiresAt: timestampSchema,
  })
  .strict();

const credentialIdentityFields = {
  id: idSchema,
  actorId: idSchema,
  expiresAt: timestampSchema,
};
export const credentialIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({ ...credentialIdentityFields, kind: z.literal("session") })
    .strict(),
  z
    .object({
      ...credentialIdentityFields,
      kind: z.literal("api_key"),
      expiresAt: timestampSchema.nullable(),
      grants: credentialGrantsSchema,
    })
    .strict(),
  z
    .object({
      ...credentialIdentityFields,
      kind: z.literal("delegation"),
      grants: z.array(projectAuthorizationGrantSchema).min(1).max(100),
      delegation: executionDelegationSchema,
    })
    .strict(),
]);

/** Structural validation only; live credential/membership/lease checks belong to the server resolver. */
export const requestIdentitySnapshotSchema = z
  .object({
    actor: activePrincipalSchema,
    credential: credentialIdentitySchema,
    verifiedAt: timestampSchema,
  })
  .strict()
  .superRefine((context, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const { actor, credential } = context;
    if (actor.id !== credential.actorId) {
      issue("Credential must be bound to the authenticated actor", [
        "credential",
        "actorId",
      ]);
    }
    if (
      credential.expiresAt !== null &&
      Date.parse(credential.expiresAt) <= Date.parse(context.verifiedAt)
    ) {
      issue("Credential must be live at verification time", [
        "credential",
        "expiresAt",
      ]);
    }
    if (credential.kind === "session" && actor.type !== "human") {
      issue("Browser sessions require a human account", ["credential", "kind"]);
    }
    if (credential.kind === "delegation") {
      const delegation = credential.delegation;
      if (actor.type !== "agent" || actor.id !== delegation.executorActorId) {
        issue("Delegation must be bound to its managed agent executor", [
          "credential",
          "delegation",
          "executorActorId",
        ]);
      }
      if (Date.parse(credential.expiresAt) > Date.parse(delegation.expiresAt)) {
        issue("Credential cannot outlive its delegation", [
          "credential",
          "expiresAt",
        ]);
      }
      const forbiddenPhasePermissions: Record<
        ExecutionDelegation["purpose"],
        readonly AuthorizationPermission[]
      > = {
        execute: ["execution.review", "execution.merge"],
        review: ["execution.run", "execution.merge"],
        merge: ["execution.run", "execution.review"],
        automation: ["execution.review", "execution.merge"],
      };
      const delegatedPermissions: readonly AuthorizationPermission[] = [
        "resource.read",
        "resource.write",
        "mcp.invoke",
        "execution.run",
        "execution.review",
        "execution.merge",
      ];
      credential.grants.forEach((grant, index) => {
        if (grant.projectId !== delegation.projectId) {
          issue("Delegated grant must use the execution project", [
            "credential",
            "grants",
            index,
            "projectId",
          ]);
        }
        grant.permissions.forEach((permission) => {
          if (
            !delegatedPermissions.includes(permission) ||
            forbiddenPhasePermissions[delegation.purpose].includes(permission)
          ) {
            issue("Permission is not available for this execution purpose", [
              "credential",
              "grants",
              index,
              "permissions",
            ]);
          }
        });
      });
    }
  });

export const authenticationErrorCodeSchema = z.enum([
  "authentication_required",
  "invalid_credential",
  "credential_expired",
  "credential_revoked",
  "principal_disabled",
]);
export const authorizationErrorCodeSchema = z.enum([
  "permission_denied",
  "csrf_rejected",
]);
export const authErrorDtoSchema = z
  .object({
    error: z.string().min(1),
    code: z.union([
      authenticationErrorCodeSchema,
      authorizationErrorCodeSchema,
    ]),
  })
  .strict();

export type Principal = z.infer<typeof principalSchema>;
export type StableActorReference = z.infer<typeof stableActorReferenceSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type InstanceRole = z.infer<typeof instanceRoleSchema>;
export type AuthorizationPermission = z.infer<
  typeof authorizationPermissionSchema
>;
export type AuthorizationScope = z.infer<typeof authorizationScopeSchema>;
export type AuthorizationGrant = z.infer<typeof authorizationGrantSchema>;
export type ProjectMembershipDto = z.infer<typeof projectMembershipDtoSchema>;
export type AccountDto = z.infer<typeof accountDtoSchema>;
export type SessionDto = z.infer<typeof sessionDtoSchema>;
export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>;
export type IssueScopedApiKey = z.infer<typeof issueScopedApiKeySchema>;
export type ExecutionDelegation = z.infer<typeof executionDelegationSchema>;
export type CredentialIdentity = z.infer<typeof credentialIdentitySchema>;
export type RequestIdentitySnapshot = z.infer<
  typeof requestIdentitySnapshotSchema
>;
export type AuthenticationErrorCode = z.infer<
  typeof authenticationErrorCodeSchema
>;
export type AuthorizationErrorCode = z.infer<
  typeof authorizationErrorCodeSchema
>;
export type AuthErrorDto = z.infer<typeof authErrorDtoSchema>;

declare const verifiedIdentity: unique symbol;
/** Only a trusted server resolver may assert this brand after live validation. Never deserialize it from a request. */
export type VerifiedRequestContext = RequestIdentitySnapshot & {
  readonly [verifiedIdentity]: true;
};

/** Eligibility only: credential/delegation ceilings and live policy checks still apply. */
export const PROJECT_ROLE_PERMISSIONS = {
  viewer: ["resource.read"],
  member: ["resource.read", "resource.write"],
  maintainer: [
    "resource.read",
    "resource.write",
    "project.manage",
    "project.members.manage",
    "agent.manage",
    "mcp.manage",
    "repository.manage",
    "execution.run",
    "webhook.manage",
    "audit.read",
  ],
  owner: [
    "resource.read",
    "resource.write",
    "project.manage",
    "project.members.manage",
    "project.ownership.manage",
    "agent.manage",
    "mcp.manage",
    "repository.manage",
    "execution.run",
    "webhook.manage",
    "audit.read",
  ],
} as const satisfies Readonly<
  Record<ProjectRole, readonly AuthorizationPermission[]>
>;

/** Membership administration can approve entitlements; it does not itself exercise those actions. */
export const PROJECT_ROLE_GRANTABLE_PERMISSIONS = {
  viewer: [],
  member: [],
  maintainer: [
    "execution.run",
    "execution.review",
    "execution.merge",
    "mcp.invoke",
  ],
  owner: ["execution.run", "execution.review", "execution.merge", "mcp.invoke"],
} as const satisfies Readonly<
  Record<
    ProjectRole,
    readonly z.infer<typeof explicitProjectPermissionSchema>[]
  >
>;

export const changeAccountStateSchema = z
  .object({
    status: z.literal("disabled").optional(),
    instanceRole: instanceRoleSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.status || value.instanceRole,
    "Account mutation is required",
  );

export const createManagedAgentSchema = z
  .object({ displayName: z.string().trim().min(1).max(255) })
  .strict();
export const setProjectMembershipSchema = z
  .object({
    role: projectRoleSchema,
    explicitPermissions: explicitProjectPermissionsSchema.default([]),
  })
  .strict();
export const managedAgentDtoSchema = z
  .object({
    id: idSchema,
    type: z.literal("agent"),
    managedByActorId: idSchema,
    deletedAt: timestampSchema.nullable(),
    displayName: z.string().min(1).max(255),
    status: principalStatusSchema,
    createdAt: timestampSchema,
  })
  .strict();


export const managedAgentListSchema = z.object({
  status: z.enum(["active", "disabled", "deleted"]).default("active"),
  query: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const managedAgentProjectsSchema = z.object({
  actorId: idSchema,
  view: z.enum(["memberships", "available"]).default("memberships"),
  query: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

/** Optimistic concurrency protects ordinary Key grant edits. */
export const updateApiKeyGrantsSchema = z.object({
  grants: credentialGrantsSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const keyGrantOptionsSchema = z.object({
  actorId: idSchema.optional(),
  query: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

/** Bounded list metadata excludes grant payloads; fetch detail only when opened. */
export const apiKeySummaryDtoSchema = apiKeyDtoSchema.omit({ grants: true });
