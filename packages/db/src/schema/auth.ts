import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { twSchema } from "./schema";
import { projects } from "./projects";

const time = (name: string) => timestamp(name, { withTimezone: true });

/** Stable principals survive credential rotation and account disablement. */
export const authActors = twSchema.table(
  "auth_actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: ["human", "agent"] }).notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("disabled"),
    managedByActorId: uuid("managed_by_actor_id"),
    managedByActorType: text("managed_by_actor_type", { enum: ["human"] }),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("auth_actors_id_type_unique").on(table.id, table.type),
    check("auth_actors_type_check", sql`${table.type} IN ('human', 'agent')`),
    check(
      "auth_actors_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
    check(
      "auth_actors_manager_check",
      sql`(${table.type} = 'human' AND ${table.managedByActorId} IS NULL AND ${table.managedByActorType} IS NULL) OR (${table.type} = 'agent' AND ${table.managedByActorId} IS NOT NULL AND ${table.managedByActorType} IS NOT NULL AND ${table.managedByActorType} = 'human')`,
    ),
    foreignKey({
      name: "auth_actors_manager_fk",
      columns: [table.managedByActorId, table.managedByActorType],
      foreignColumns: [table.id, table.type],
    }).onDelete("restrict"),
    index("auth_actors_manager_idx").on(table.managedByActorId),
  ],
);

/** Better Auth user fields plus server-managed Task Weaver identity fields. */
export const authUsers = twSchema.table(
  "auth_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").notNull().unique(),
    actorType: text("actor_type", { enum: ["human"] })
      .notNull()
      .default("human"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("disabled"),
    instanceRole: text("instance_role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "auth_users_human_actor_fk",
      columns: [table.actorId, table.actorType],
      foreignColumns: [authActors.id, authActors.type],
    }).onDelete("restrict"),
    check("auth_users_human_check", sql`${table.actorType} = 'human'`),
    check(
      "auth_users_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
    check(
      "auth_users_role_check",
      sql`${table.instanceRole} IN ('user', 'admin')`,
    ),
    uniqueIndex("auth_users_email_unique").on(sql`lower(${table.email})`),
    index("auth_users_admin_idx").on(table.instanceRole, table.status),
  ],
);

export const authAccounts = twSchema.table(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: time("access_token_expires_at"),
    refreshTokenExpiresAt: time("refresh_token_expires_at"),
    scope: text("scope"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("auth_accounts_provider_identity_unique").on(
      table.providerId,
      table.accountId,
    ),
    unique("auth_accounts_user_provider_unique").on(
      table.userId,
      table.providerId,
    ),
    // Only local credentials are supported in this release; fields above match the provider adapter.
    check(
      "auth_accounts_local_check",
      sql`${table.providerId} = 'credential' AND ${table.password} IS NOT NULL AND ${table.accessToken} IS NULL AND ${table.refreshToken} IS NULL AND ${table.idToken} IS NULL`,
    ),
  ],
);

export const authSessions = twSchema.table(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    token: text("token").notNull().unique(),
    expiresAt: time("expires_at").notNull(),
    absoluteExpiresAt: time("absolute_expires_at").notNull(),
    idleExpiresAt: time("idle_expires_at").notNull(),
    revokedAt: time("revoked_at"),
    lastSeenAt: time("last_seen_at"),
    authenticatedAt: time("authenticated_at").notNull().defaultNow(),
    idleTimeoutSeconds: integer("idle_timeout_seconds")
      .notNull()
      .default(86400),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "auth_sessions_lifetime_check",
      sql`isfinite(${table.absoluteExpiresAt}) AND isfinite(${table.idleExpiresAt}) AND isfinite(${table.expiresAt}) AND ${table.absoluteExpiresAt} > ${table.createdAt} AND ${table.idleExpiresAt} > ${table.createdAt} AND ${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.absoluteExpiresAt} AND ${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
    check(
      "auth_sessions_recency_check",
      sql`isfinite(${table.authenticatedAt}) AND ${table.idleTimeoutSeconds} > 0`,
    ),
    index("auth_sessions_user_idx").on(table.userId, table.revokedAt),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const authVerifications = twSchema.table(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);

export const projectMemberships = twSchema.table(
  "project_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id").notNull(),
    actorType: text("actor_type", { enum: ["human", "agent"] }).notNull(),
    role: text("role", {
      enum: ["owner", "maintainer", "member", "viewer"],
    }).notNull(),
    explicitPermissions: text("explicit_permissions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    removedAt: time("removed_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "project_memberships_actor_fk",
      columns: [table.actorId, table.actorType],
      foreignColumns: [authActors.id, authActors.type],
    }).onDelete("restrict"),
    unique("project_memberships_project_actor_unique").on(
      table.projectId,
      table.actorId,
    ),
    check(
      "project_memberships_role_check",
      sql`${table.role} IN ('owner', 'maintainer', 'member', 'viewer') AND (${table.role} <> 'owner' OR ${table.actorType} = 'human')`,
    ),
    check(
      "project_memberships_permissions_check",
      sql`${table.explicitPermissions} <@ ARRAY['execution.run', 'execution.review', 'execution.merge', 'mcp.invoke']::text[]`,
    ),
    index("project_memberships_actor_idx").on(table.actorId, table.removedAt),
    index("project_memberships_owner_idx").on(
      table.projectId,
      table.role,
      table.removedAt,
    ),
  ],
);

/** Seeded singleton provides a transaction lock for Secret-based first-admin setup. */
export const authInstanceState = twSchema.table(
  "auth_instance_state",
  {
    id: text("id").primaryKey().default("instance"),
    initializedByUserId: uuid("initialized_by_user_id").references(
      () => authUsers.id,
      { onDelete: "restrict" },
    ),
    initializedAt: time("initialized_at"),
  },
  (table) => [
    check("auth_instance_state_singleton_check", sql`${table.id} = 'instance'`),
    check(
      "auth_instance_state_initialized_check",
      sql`(${table.initializedByUserId} IS NULL) = (${table.initializedAt} IS NULL)`,
    ),
  ],
);

export const authActivations = twSchema.table(
  "auth_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose", { enum: ["invite", "recovery"] }).notNull(),
    expiresAt: time("expires_at").notNull(),
    consumedAt: time("consumed_at"),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "auth_activations_purpose_check",
      sql`${table.purpose} IN ('invite', 'recovery')`,
    ),
    check(
      "auth_activations_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_activations_expiry_check",
      sql`isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
    index("auth_activations_user_idx").on(table.userId),
  ],
);

/** A3 must configure UUID generation and server-only additional fields before enabling this adapter. */
export const betterAuthTables = {
  user: authUsers,
  account: authAccounts,
  session: authSessions,
  verification: authVerifications,
};

/** Shared rate limits contain digest keys, never submitted identifiers or secrets. */
export const authRateLimits = twSchema.table(
  "auth_rate_limits",
  {
    id: text("id").primaryKey(),
    count: integer("count").notNull(),
    windowStartedAt: time("window_started_at").notNull(),
  },
  (table) => [
    check("auth_rate_limits_count_check", sql`${table.count} > 0`),
    index("auth_rate_limits_window_idx").on(table.windowStartedAt),
  ],
);

/** Server-generated metadata is limited to non-secret policy decisions. */
export const authAuditEvents = twSchema.table("auth_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  actorId: uuid("actor_id").references(() => authActors.id, {
    onDelete: "restrict",
  }),
  subjectActorId: uuid("subject_actor_id").references(() => authActors.id, {
    onDelete: "restrict",
  }),
  entityId: uuid("entity_id"),
  metadata: jsonb("metadata")
    .$type<Record<string, string | number | boolean>>()
    .notNull()
    .default({}),
  createdAt: time("created_at").notNull().defaultNow(),
});
