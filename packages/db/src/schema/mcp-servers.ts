import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorTypeEnum } from "./enums";
import { projects } from "./projects";

export interface McpServerStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    transport: text("transport", {
      enum: ["stdio", "sse", "streamable-http"],
    }).notNull(),
    registeredBy: text("registered_by"),
    registeredCredentialId: text("registered_credential_id"),
    config: jsonb("config").notNull().$type<McpServerConfig>(),
    active: boolean("active").notNull().default(true),
    status: text("status", {
      enum: ["disconnected", "connected", "error"],
    }).notNull().default("disconnected"),
    statusMessage: text("status_message"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    tags: text("tags").array(),
    clientId: text("client_id"),
    nodeId: text("node_id"),
    scope: text("scope", { enum: ["private", "local"] }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ttl: integer("ttl").default(60).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_mcp_servers_scope_name").on(table.name, sql`coalesce(${table.projectId}::text, '')`, sql`coalesce(${table.personalOwnerId}, '')`),
    index("idx_mcp_servers_active").on(table.active),
    index("idx_mcp_servers_project").on(table.projectId),
    index("idx_mcp_servers_personal_owner").on(table.personalOwnerId, table.personalOwnerType),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .references(() => mcpServers.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    tags: text("tags").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_mcp_tools_server").on(table.serverId),
    uniqueIndex("idx_mcp_tools_server_name").on(table.serverId, table.name),
  ],
);

export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolId: uuid("tool_id")
      .references(() => mcpTools.id, { onDelete: "set null" }),
    serverId: uuid("server_id")
      .references(() => mcpServers.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output"),
    status: text("status", {
      enum: ["success", "error"],
    }).notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    calledBy: text("called_by").notNull(),
    calledByType: text("called_by_type", {
      enum: ["human", "agent"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_mcp_tool_calls_tool").on(table.toolId),
    index("idx_mcp_tool_calls_server").on(table.serverId),
    index("idx_mcp_tool_calls_created").on(table.createdAt),
  ],
);

/** Ephemeral client-hosted invocation mailbox; payloads are cleared after delivery/expiry. */
export const mcpLocalRequests = pgTable("mcp_local_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  toolId: uuid("tool_id").references(() => mcpTools.id, { onDelete: "set null" }),
  toolName: text("tool_name").notNull(),
  callerContext: jsonb("caller_context").notNull().$type<Record<string, unknown>>(),
  calledBy: text("called_by").notNull(),
  calledByType: actorTypeEnum("called_by_type").notNull(),
  arguments: jsonb("arguments").$type<Record<string, unknown>>(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["queued", "running", "completed", "cancelled"] }).notNull().default("queued"),
  leaseHash: text("lease_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("idx_mcp_local_requests_server").on(table.serverId, table.status)]);
