import type { Database } from "@task-weaver/db";
import { AuthorizationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { getLiveRequestAuthority } from "./api-keys";
import { assistantReadTools, runAssistantReadTool } from "./assistant-read-tools";
import { assistantOperationTools, executeAssistantOperation } from "./assistant-operations";
import { createResourceServices } from "./resource-services";

const taskReads = new Set(["get_project", "get_requirement", "get_task", "list_tasks", "list_requirements", "list_documents", "get_document",
  "list_skills", "get_skill", "load_skill", "read_skill_file", "search_memories", "list_memories", "get_memory",
  "list_mcp_servers", "get_mcp_server", "search_mcp_tools", "get_mcp_tool"]);
const taskWrites = new Set(["add_comment", "add_note", "update_task", "update_document", "call_mcp_tool"]);

/** Shared capability vocabulary; the caller retains confirmation, durable operation receipts and execution leases. */
export function createTiCapabilities(db: Database, identity: () => Promise<VerifiedRequestContext>, mode: "chat" | "task") {
  async function current() {
    const context = await identity();
    const live = await getLiveRequestAuthority(db, context);
    if (mode === "chat" ? live.bounds || live.actor.type !== "human" : live.bounds?.purpose !== "automation") throw new AuthorizationError();
    return { context, live };
  }
  return {
    readTools: mode === "chat" ? assistantReadTools : assistantReadTools.filter(tool => taskReads.has(tool.function.name)),
    operationTools: mode === "chat" ? assistantOperationTools : assistantOperationTools.filter(tool => taskWrites.has(tool.function.name)),
    async read(name: string, input: unknown) {
      if (mode === "task" && !taskReads.has(name)) throw new AuthorizationError();
      const { context } = await current();
      const result = await runAssistantReadTool(db, context, name, input);
      await current();
      return result;
    },
    /** Chat calls this only inside its approved-action supervisor. Tasks use their bounded delegation. */
    async operation(name: string, input: unknown) {
      if (mode === "task" && !taskWrites.has(name)) throw new AuthorizationError();
      const { context, live } = await current();
      const result = await executeAssistantOperation(db, createResourceServices(context), name, input, { id: live.actor.id, type: live.actor.type });
      await current();
      return result;
    },
  };
}
