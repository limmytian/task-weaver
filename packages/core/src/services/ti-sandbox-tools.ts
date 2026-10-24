import { inputJsonSchema } from "@task-weaver/contracts";
import { createHash } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { tiSandboxWorkspaces, type Database } from "@task-weaver/db";
import { ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { z } from "zod";
import { connectPartnersMcp } from "./partners-mcp";
import { createTiSandboxAuthority } from "./ti-sandbox-authorization";
import { createTiSandboxService } from "./ti-sandboxes";

export const tiSandboxToolSchemas = {
  sandbox_exec: z.object({ command: z.string().min(1).max(65_536), timeoutSeconds: z.number().int().min(1).max(900).optional() }).strict(),
  sandbox_job: z.object({ operationKey: z.string().min(1).max(200), cursor: z.string().max(100).optional() }).strict(),
  sandbox_read: z.object({ path: z.string().min(1).max(1024), offsetBytes: z.number().int().nonnegative().optional() }).strict(),
  sandbox_write: z.object({ path: z.string().min(1).max(1024), content: z.string().max(262_144), createOnly: z.boolean().optional(), expectedHash: z.string().optional() }).strict(),
};
const descriptions = {
  sandbox_exec: "Start one bounded sandbox command in the current owned workspace. Poll its operationKey until terminal and drain output cursors. A nonzero exit is a failure.",
  sandbox_job: "Poll this workspace's command operationKey. Continue returned cursors until all output is exhausted, including after terminal state.",
  sandbox_read: "Read a bounded UTF-8 file in the current owned workspace.",
  sandbox_write: "Conditionally write a UTF-8 file. Supply createOnly=true or expectedHash from a prior read.",
};
export const tiSandboxTools = Object.entries(tiSandboxToolSchemas).map(([name, schema]) => {
  const parameters = inputJsonSchema(schema); delete parameters.$schema;
  return { type: "function", function: { name, description: descriptions[name as keyof typeof descriptions], parameters } };
});
export function configuredTiSandboxBinding(env: NodeJS.ProcessEnv = process.env) {
  const url = env.PARTNERS_MCP_URL ?? (env.PARTNERS_GATEWAY_URL ? `${env.PARTNERS_GATEWAY_URL.replace(/\/+$/, "")}/mcp` : undefined);
  const tenantId = env.PARTNERS_GATEWAY_TENANT_ID, projectId = env.PARTNERS_GATEWAY_PROJECT_ID, serviceToken = env.PARTNERS_GATEWAY_SERVICE_TOKEN;
  if (!url || !tenantId || !projectId || !serviceToken) throw new ValidationError("An explicit trusted Partners MCP binding is required");
  const digest = createHash("sha256").update(JSON.stringify([url, tenantId, projectId])).digest("hex");
  return { id: `partners:${digest}`, tenantId, projectId, adapter: connectPartnersMcp({ id: `ti-partners:${digest}`, url, serviceToken, partition: digest }) };
}

/** Only the approved chat action supplies conversation identity and the durable logical operation key. */
export async function executeChatSandboxTool(db: Database, identity: VerifiedRequestContext, conversationId: string, actionId: string,
  name: keyof typeof tiSandboxToolSchemas, raw: unknown) {
  const initial = await createTiSandboxAuthority(db, identity, { conversationId, attempt: 1 })();
  const prior = await db.query.tiSandboxWorkspaces.findFirst({ where: and(eq(tiSandboxWorkspaces.conversationId, conversationId),
    eq(tiSandboxWorkspaces.ownerId, initial.ownerId), eq(tiSandboxWorkspaces.ownerType, initial.ownerType)), orderBy: desc(tiSandboxWorkspaces.attempt) });
  const reusable = prior?.state === "active" && !prior.cleanupRequestedAt && !prior.cancelRequestedAt && prior.expiresAt > new Date();
  if (prior && !reusable) await db.update(tiSandboxWorkspaces).set({ state: "cleanup_pending", cleanupRequestedAt: new Date(), nextCleanupAt: new Date() })
    .where(and(eq(tiSandboxWorkspaces.id, prior.id), ne(tiSandboxWorkspaces.state, "deleted")));
  const attempt = reusable ? prior.attempt : (prior?.attempt ?? 0) + 1;
  const sandbox = createTiSandboxService(db, createTiSandboxAuthority(db, identity, { conversationId, attempt }), configuredTiSandboxBinding());
  let result: unknown;
  if (name === "sandbox_exec") {
    result = await sandbox.execute(actionId, tiSandboxToolSchemas.sandbox_exec.parse(raw));
    result = { operationKey: actionId, state: "state" in (result as object) ? (result as Record<string, unknown>).state : "unknown" };
  } else if (name === "sandbox_job") {
    const { operationKey, ...input } = tiSandboxToolSchemas.sandbox_job.parse(raw);
    const { jobId: _job, sessionId: _session, ...output } = await sandbox.getJob(operationKey, input);
    result = { operationKey, ...output };
  } else if (name === "sandbox_read") {
    const { sessionId: _session, ...output } = await sandbox.read(tiSandboxToolSchemas.sandbox_read.parse(raw)); result = output;
  } else {
    const output = await sandbox.write(actionId, tiSandboxToolSchemas.sandbox_write.parse(raw));
    const { sessionId: _session, ...rest } = output; result = rest;
  }
  return { id: actionId, result };
}
