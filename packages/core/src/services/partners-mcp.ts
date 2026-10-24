import { z } from "zod";
import { mcpPool, type McpServerRecord } from "./mcp-pool";

const id = z.string().min(1).max(200);
const requestId = z.string().min(8).max(200).regex(/^[A-Za-z0-9._~:-]+$/);
const path = z.string().min(1).max(1024).refine(value => !value.includes("\0") && !value.startsWith("/")
  && !value.includes("\\") && !value.split("/").includes(".."), "Expected a relative workspace path");
const bytes = z.number().int().min(4).max(65_536);
const fileWrite = z.object({ sessionId: id, action: z.literal("write"), path,
  content: z.string().refine(value => Buffer.byteLength(value) <= 262_144, "File is too large"), requestId,
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), createOnly: z.boolean().optional(),
}).strict().refine(value => (value.createOnly === true) !== (value.expectedHash !== undefined), "Specify one write precondition");

/** Consumer contract pinned to Partners sandbox MCP v1; no generic tool names or infrastructure IDs from models. */
export const partnersMcpInputs = {
  session_create: z.object({ requestId, tenantId: id, projectId: id,
    profile: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(), ttlSeconds: z.number().int().min(60).max(1800).default(1800) }).strict(),
  session_get: z.object({ sessionId: id }).strict(),
  session_delete: z.object({ sessionId: id }).strict(),
  bash_exec: z.object({ sessionId: id, command: z.string().min(1).max(65_536).refine(value => Buffer.byteLength(value) <= 65_536),
    cwd: path.default("."), timeoutSeconds: z.number().int().min(1).max(900).default(120), requestId }).strict(),
  job_get: z.object({ jobId: id, cursor: z.string().regex(/^\d+:\d+$/).max(100).default("0:0"), maxOutputBytes: bytes.default(16_384) }).strict(),
  job_cancel: z.object({ jobId: id, reason: z.string().min(1).max(256).default("client requested cancellation") }).strict(),
  file_ops: z.union([
    z.object({ sessionId: id, action: z.literal("list"), path: path.default("."), depth: z.number().int().min(0).max(5).default(3),
      cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    z.object({ sessionId: id, action: z.literal("read"), path, offsetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), maxBytes: bytes.default(16_384) }).strict(),
    fileWrite,
  ]),
};
const session = z.object({ sessionId: id, state: z.string().min(1).max(64), expiresAt: z.number().nullable(), quarantined: z.boolean(),
  capabilities: z.object({ bash_exec: z.boolean(), file_ops: z.boolean() }), limits: z.record(z.string(), z.number()) });
const job = z.object({ jobId: id, sessionId: id, state: z.enum(["queued", "accepted", "preparing", "running", "cancel_requested", "succeeded", "failed", "timed_out", "cancelled"]),
  exitCode: z.number().int().nullable(), terminalReason: z.string().max(256).nullable(), outputTruncated: z.boolean() });
const page = job.extend({ stdout: z.string(), stderr: z.string(), nextCursor: z.string().regex(/^\d+:\d+$/).max(100), truncated: z.boolean(),
  artifactRefs: z.array(z.object({ artifactId: id, kind: z.string(), name: z.string(), downloadPath: z.string() })).max(1000) });
const fileResult = z.union([
  z.object({ sessionId: id, path: z.string(), content: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative(), nextOffsetBytes: z.number().int().nonnegative(), truncated: z.boolean() }),
  z.object({ sessionId: id, path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative() }),
  z.object({ sessionId: id, path: z.string(), entries: z.array(z.object({ path: z.string(), type: z.enum(["file", "directory"]), sizeBytes: z.number().nullable() })).max(500), nextCursor: z.string().nullable() }),
]);
const outputs = { session_create: session, session_get: session, session_delete: session,
  bash_exec: z.object({ jobId: id, sessionId: id, state: z.literal("accepted") }), job_get: page, job_cancel: job, file_ops: fileResult };
export type PartnersMcpTool = keyof typeof partnersMcpInputs;
export type PartnersJobPage = z.infer<typeof page>;
export type PartnersMcpCall = (name: PartnersMcpTool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{
  isError?: boolean; structuredContent?: unknown; content?: unknown;
}>;

export class PartnersMcpError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly resource: { sessionId?: string; jobId?: string; traceId?: string } = {}) {
    super(`Partners MCP operation failed: ${code}`);
    this.name = "PartnersMcpError";
  }
}
const failure = z.object({ code: z.string().regex(/^[A-Z_]+$/).max(100), retryable: z.boolean(), sessionId: id.optional(), jobId: id.optional(), traceId: id.optional() });

/** Trusted adapter only. The ownership supervisor supplies persisted IDs and request IDs. No automatic mutation retries. */
export function createPartnersMcpAdapter(call: PartnersMcpCall) {
  return {
    async invoke<K extends PartnersMcpTool>(name: K, input: z.input<(typeof partnersMcpInputs)[K]>, signal?: AbortSignal): Promise<z.infer<(typeof outputs)[K]>> {
      signal?.throwIfAborted();
      const args = partnersMcpInputs[name].parse(input);
      let result: Awaited<ReturnType<PartnersMcpCall>>;
      try { result = await call(name, args, signal); }
      catch { throw new PartnersMcpError("TRANSPORT_OUTCOME_UNKNOWN", false); }
      const value = result.structuredContent;
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > 1_048_576) throw new PartnersMcpError("INVALID_RESPONSE", false);
      const error = failure.safeParse(value);
      if (result.isError && error.success) {
        const { code, retryable, ...resource } = error.data;
        throw new PartnersMcpError(code, retryable, resource);
      }
      const parsed = outputs[name].safeParse(value);
      // Partners marks failed job_get results isError=true while still returning a valid terminal job.
      if (!parsed.success || (result.isError && !(name === "job_get" && "state" in parsed.data
        && ["failed", "timed_out", "cancelled"].includes(String(parsed.data.state))))) throw new PartnersMcpError("INVALID_RESPONSE", false);
      if ("sessionId" in args && "sessionId" in parsed.data && args.sessionId !== parsed.data.sessionId
        || "jobId" in args && "jobId" in parsed.data && args.jobId !== parsed.data.jobId) throw new PartnersMcpError("RESOURCE_MISMATCH", false);
      if (name === "job_get") {
        const output = parsed.data as PartnersJobPage;
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > (args as z.output<typeof partnersMcpInputs.job_get>).maxOutputBytes)
          throw new PartnersMcpError("INVALID_RESPONSE", false);
      }
      return parsed.data as z.infer<(typeof outputs)[K]>;
    },
  };
}

/** Uses the existing MCP pool, with a separate trusted infrastructure partition. Never register this binding as a public tool. */
export function connectPartnersMcp(binding: { id: string; url: string; serviceToken: string; partition: string }) {
  const endpoint = new URL(binding.url);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid Partners MCP endpoint");
  const server: McpServerRecord = { id: binding.id, name: "Partners sandbox", transport: "streamable-http",
    authorizationPartition: `ti-infrastructure:${binding.partition}`,
    config: { url: binding.url, headers: { Authorization: `Bearer ${binding.serviceToken}` } } };
  return createPartnersMcpAdapter(async (name, args, signal) => {
    const client = await mcpPool.getOrConnect(server);
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 30_000 });
    return { isError: result.isError === true, structuredContent: result.structuredContent };
  });
}
