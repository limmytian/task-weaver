import { z } from "zod";

// Inbound MCP contracts are separate from the outbound MCP registry schemas.
export const MCP_SERVER_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_SERVER_LIMITS = Object.freeze({
  pageSize: 50,
  defaultPageSize: 20,
  requestBytes: 1_048_576,
  resultBytes: 262_144,
  concurrentCalls: 8,
  timeoutMs: 30_000,
});

export const mcpServerPageSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MCP_SERVER_LIMITS.pageSize)
    .default(MCP_SERVER_LIMITS.defaultPageSize),
}).strict();

export const mcpServerErrorCodeSchema = z.enum([
  "approval_required",
  "validation_error",
  "unauthenticated",
  "forbidden",
  "not_found",
  "version_conflict",
  "dependency_conflict",
  "claim_conflict",
  "conflict",
  "read_only",
  "result_too_large",
  "busy",
  "timeout",
  "cancelled",
  "upstream_error",
]);

export const mcpServerToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: mcpServerErrorCodeSchema,
    message: z.string().min(1).max(1000),
    approvalId: z.string().uuid().optional(),
  }).strict(),
}).strict();

export const mcpServerReadTools = [
  "tw_projects_discover", "tw_projects_list", "tw_projects_get",
  "tw_requirements_list", "tw_requirements_get", "tw_requirement_dependencies_list",
  "tw_tasks_list", "tw_tasks_get", "tw_task_comments_list", "tw_task_dependencies_list",
  "tw_documents_list", "tw_documents_get", "tw_search",
  "tw_context_bootstrap", "tw_context_search", "tw_context_get",
  "tw_skill_packages_list", "tw_skill_packages_get", "tw_skill_package_files", "tw_skill_package_read",
  "tw_dependencies_graph",
  "tw_execution_slices_list", "tw_plan_validate", "tw_tasks_context", "tw_requirements_context",
  "tw_memories_search", "tw_memories_get", "tw_memories_preview",
  "tw_skill_packages_resolve",
  "tw_skill_runtimes_list",
  "tw_mcp_search", "tw_mcp_tool", "tw_mcp_readiness",
] as const;

export const mcpServerWriteTools = [
  "tw_requirements_create", "tw_requirements_update",
  "tw_requirement_dependencies_add", "tw_requirement_dependencies_remove",
  "tw_tasks_create", "tw_tasks_update", "tw_tasks_status",
  "tw_tasks_claim", "tw_tasks_heartbeat", "tw_tasks_release",
  "tw_task_comments_add", "tw_task_dependencies_add", "tw_task_dependencies_remove",
  "tw_documents_create", "tw_documents_update",
  "tw_document_task_links_add", "tw_document_requirement_links_add",
  "tw_execution_slices_create", "tw_execution_slices_update", "tw_plan_apply",
  "tw_memories_record", "tw_memories_update", "tw_memories_forget",
  "tw_skills_run", "tw_mcp_call",
] as const;

export type McpServerToolName =
  | typeof mcpServerReadTools[number]
  | typeof mcpServerWriteTools[number];

/** Discovery and dispatch must both use this policy; annotations grant no authority. */
export function isMcpServerToolAllowed(name: string, readOnly: boolean): name is McpServerToolName {
  return (mcpServerReadTools as readonly string[]).includes(name)
    || (!readOnly && (mcpServerWriteTools as readonly string[]).includes(name));
}

export type McpServerToolError = z.infer<typeof mcpServerToolErrorSchema>;
