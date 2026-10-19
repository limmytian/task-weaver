import { McpApprovalRequired } from "../services/mcp-security";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  APPLICATION_VERSION, AuthenticationError, AuthorizationError, NotFoundError, ValidationError, ConflictError, ClaimConflictError, DependencyConflictError,
  mcpServerCatalog, mcpServerReadTools, isMcpServerToolAllowed, parseMcpServerArguments,
  MCP_SERVER_LIMITS, type McpServerToolName, type McpServerToolError,
} from "@task-weaver/contracts";

export type McpExecutor = (name: McpServerToolName, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export class McpToolFailure extends Error {
  constructor(readonly code: McpServerToolError["error"]["code"], message: string, readonly approvalId?: string) { super(message); }
}
export function isMcpArgumentError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams;
}
export interface McpCallBudget { active: number; pending?: Set<Promise<unknown>> }
export interface McpServerOptions {
  readOnly?: boolean;
  onRejected?: (name: string, code: string) => Promise<void>;
  signal?: AbortSignal;
  budget?: McpCallBudget;
  timeoutMs?: number;
}

function failure(code: McpServerToolError["error"]["code"], message: string): McpServerToolError {
  return { ok: false, error: { code, message } };
}
function toolResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function publicFailure(error: unknown): McpServerToolError {
  if (error instanceof McpApprovalRequired) return { ok: false, error: { code: "approval_required", message: error.message, approvalId: error.approvalId } };
  if (error instanceof McpToolFailure) return { ok: false, error: { code: error.code, message: error.message, ...(error.approvalId ? { approvalId: error.approvalId } : {}) } };
  if (error instanceof AuthenticationError) return failure("unauthenticated", "Authentication required.");
  if (error instanceof AuthorizationError) return failure("forbidden", "Access denied.");
  if (error instanceof NotFoundError) return failure("not_found", "Resource not found.");
  if (error instanceof ConflictError) return failure("version_conflict", "Read the current version before updating.");
  if (error instanceof ClaimConflictError) return failure("claim_conflict", "The task is claimed by another participant.");
  if (error instanceof DependencyConflictError) return failure("dependency_conflict", "Blocking dependencies must be completed first.");
  if (error instanceof ValidationError) return failure("validation_error", "The operation violates a resource, dependency, claim or workflow rule.");
  return failure("upstream_error", "The operation could not be completed. Read current state before retrying a write.");
}

/** Shared validation and resource budget for JSON and protocol callers. */
export function createMcpToolCaller(execute: McpExecutor, options: McpServerOptions = {}) {
  const budget = options.budget ?? { active: 0 };
  return async (name: string, raw: unknown, requestSignal?: AbortSignal): Promise<CallToolResult> => {
    if (!isMcpServerToolAllowed(name, false)) { await options.onRejected?.("unknown", "validation_error"); throw new McpError(ErrorCode.InvalidParams, "Unknown tool"); }
    if (!isMcpServerToolAllowed(name, options.readOnly ?? false)) { await options.onRejected?.(name, "read_only"); return toolResult(failure("read_only", "Writes are disabled."), true); }
    let input: Record<string, unknown>;
    try { input = parseMcpServerArguments(name, raw); }
    catch { await options.onRejected?.(name, "validation_error"); throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments"); }
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MCP_SERVER_LIMITS.requestBytes) throw new McpError(ErrorCode.InvalidParams, "Tool arguments exceed the request limit");
    if (budget.active >= MCP_SERVER_LIMITS.concurrentCalls) return toolResult(failure("busy", "Too many active calls."), true);
    const controller = new AbortController();
    const signals = [controller.signal, options.signal, requestSignal].filter((signal): signal is AbortSignal => !!signal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return toolResult(failure("cancelled", "Call cancelled before dispatch."), true);
    budget.active++;
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MCP_SERVER_LIMITS.timeoutMs);
    timer.unref();
    let removeAbort = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new McpToolFailure(controller.signal.aborted ? "timeout" : "cancelled", "Call interrupted; a dispatched write may have committed. Read current state before retrying."));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    // Keep the permit until actual execution settles, even when the caller times out.
    const running = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return execute(name, input, signal);
    });
    budget.pending?.add(running);
    const settled = () => { budget.active--; budget.pending?.delete(running); };
    void running.then(settled, settled);
    try {
      const data = await Promise.race([running, interrupted]);
      const value = { ok: true, data: data ?? null };
      const result = toolResult(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MCP_SERVER_LIMITS.resultBytes) {
        return toolResult(failure("result_too_large", "Result exceeds the limit. A dispatched write may have committed; read current state before retrying."), true);
      }
      // Normalize dates and other JSON values identically for both transports.
      return result;
    } catch (error) {
      return toolResult(publicFailure(error), true);
    } finally {
      clearTimeout(timer);
      removeAbort();
    }
  };
}

export function createTaskWeaverMcpServer(call: ReturnType<typeof createMcpToolCaller>, options: { readOnly?: boolean; visibleTools?: () => Promise<readonly string[]> } = {}) {
  const server = new Server({ name: "task-weaver", version: APPLICATION_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visible = options.visibleTools ? await options.visibleTools() : undefined;
    return { tools: mcpServerCatalog
    .filter(tool => isMcpServerToolAllowed(tool.name, options.readOnly ?? false) && (!visible || visible.includes(tool.name)))
    .map(tool => {
      const readOnly = (mcpServerReadTools as readonly string[]).includes(tool.name);
      const destructive = /_(update|remove|status)$/.test(tool.name);
      return { _meta: { available: true, stableId: tool.name, source: "task-weaver", requiredPermissions: [readOnly ? "resource.read" : "resource.write"], targetAuthorization: "Every target is checked against current credential scope on each call." }, name: tool.name, description: tool.description, inputSchema: zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" }) as { type: "object" },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && destructive, idempotentHint: readOnly, openWorldHint: true } };
    }) };
  });
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => call(request.params.name, request.params.arguments ?? {}, extra.signal));
  return server;
}
