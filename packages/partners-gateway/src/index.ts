import { z } from "zod";

import { executionDelegationSchema, type ExecutionDelegation, type CompleteTiAgentRunInput } from "@task-weaver/contracts";

const optionalString = (schema: z.ZodString) => z.preprocess(
  (value) => value === "" ? undefined : value,
  schema.optional(),
);

const gatewayConfigSchema = z.object({
  baseUrl: optionalString(z.string().url()),
  serviceToken: optionalString(z.string().min(1)),
  tenantId: optionalString(z.string().min(1)),
  projectId: optionalString(z.string().min(1)),
  defaultTimeoutSeconds: z.coerce.number().int().min(30).max(86_400).default(900),
}).superRefine((config, ctx) => {
  if (Boolean(config.baseUrl) !== Boolean(config.serviceToken)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PARTNERS_GATEWAY_URL and PARTNERS_GATEWAY_SERVICE_TOKEN must be configured together",
    });
  }
});

const gatewayWorkerConfigSchema = z.object({
  actorId: optionalString(z.string().min(1)).default("task-weaver:ti-agent"),
  assignedAgentId: optionalString(z.string().min(1)).default("task-weaver:ti-agent"),
  workerId: optionalString(z.string().min(1)),
  leaseDurationMinutes: z.coerce.number().int().min(1).max(15).default(15),
  heartbeatIntervalMs: z.coerce.number().int().min(100).max(86_400_000).default(300_000),
  progressFlushIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(2_000),
  idlePollIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(5_000),
  statusPollIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(2_000),
  retryBaseDelayMs: z.coerce.number().int().min(100).max(3_600_000).default(1_000),
  retryMaxDelayMs: z.coerce.number().int().min(100).max(86_400_000).default(300_000),
}).superRefine((config, ctx) => {
  if (config.heartbeatIntervalMs >= config.leaseDurationMinutes * 60_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["heartbeatIntervalMs"],
      message: "Gateway worker heartbeat interval must be shorter than the lease duration",
    });
  }
  if (config.retryBaseDelayMs > config.retryMaxDelayMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retryBaseDelayMs"],
      message: "Gateway worker retry base delay cannot exceed the maximum delay",
    });
  }
});

export type PartnersGatewayConfig = z.infer<typeof gatewayConfigSchema> & {
  enabled: boolean;
};
export type PartnersGatewayWorkerConfig = z.infer<typeof gatewayWorkerConfigSchema>;

export type PartnersGatewayJobRequest = {
  id?: string;
  tenantId?: string;
  projectId?: string;
  executionMode: "ephemeral_interpreter" | "workspace_session";
  sessionId?: string | null;
  command?: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  inputs?: {
    files: Array<{ path: string; content: string }>;
  };
  timeoutSeconds: number;
  artifactPolicy?: { collect: string[] };
  metadata?: Record<string, unknown>;
};

export type PartnersGatewayJob = {
  id: string;
  sessionId?: string | null;
  state: "queued" | "preparing" | "running" | "cancel_requested" | "cancelled" | "succeeded" | "failed" | "timed_out";
  executionMode: PartnersGatewayJobRequest["executionMode"];
  provider?: string;
  exitCode?: number | null;
  terminalReason?: string | null;
  artifactCount?: number;
  metadata?: Record<string, unknown>;
};

export type PartnersGatewaySession = {
  id: string;
  state: "starting" | "running" | "stopped" | "failed";
  metadata?: Record<string, unknown>;
};

export type PartnersGatewayEvent = {
  id?: string;
  type: string;
  sequence: number;
  at?: string;
  jobId?: string;
  state?: PartnersGatewayJob["state"];
  chunk?: string;
  artifact?: unknown;
  [key: string]: unknown;
};

export class PartnersGatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PartnersGatewayError";
  }
}

export type PartnersGatewayTiRun = {
  id: string;
  taskId?: string | null;
  scheduleRunId?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  actualProvider?: string | null;
  actualModel?: string | null;
  workspacePolicy?: "ephemeral" | "persistent_purged_on_finish" | null;
  sandboxSessionId?: string | null;
  task?: {
    id: string;
    title: string;
    description?: string | null;
    priority: string;
  } | null;
};

export function getPartnersGatewayConfig(env: NodeJS.ProcessEnv = process.env): PartnersGatewayConfig {
  const parsed = gatewayConfigSchema.parse({
    baseUrl: env.PARTNERS_GATEWAY_URL,
    serviceToken: env.PARTNERS_GATEWAY_SERVICE_TOKEN,
    tenantId: env.PARTNERS_GATEWAY_TENANT_ID,
    projectId: env.PARTNERS_GATEWAY_PROJECT_ID,
    defaultTimeoutSeconds: env.PARTNERS_GATEWAY_DEFAULT_TIMEOUT_SECONDS,
  });

  return {
    ...parsed,
    enabled: Boolean(parsed.baseUrl && parsed.serviceToken),
  };
}

export function getPartnersGatewayWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): PartnersGatewayWorkerConfig {
  return gatewayWorkerConfigSchema.parse({
    actorId: env.PARTNERS_GATEWAY_WORKER_ACTOR_ID,
    assignedAgentId: env.PARTNERS_GATEWAY_WORKER_ASSIGNED_AGENT_ID,
    workerId: env.PARTNERS_GATEWAY_WORKER_ID,
    leaseDurationMinutes: env.PARTNERS_GATEWAY_WORKER_LEASE_MINUTES,
    heartbeatIntervalMs: env.PARTNERS_GATEWAY_WORKER_HEARTBEAT_INTERVAL_MS,
    progressFlushIntervalMs: env.PARTNERS_GATEWAY_WORKER_PROGRESS_FLUSH_MS,
    idlePollIntervalMs: env.PARTNERS_GATEWAY_WORKER_IDLE_POLL_MS,
    statusPollIntervalMs: env.PARTNERS_GATEWAY_WORKER_STATUS_POLL_MS,
    retryBaseDelayMs: env.PARTNERS_GATEWAY_WORKER_RETRY_BASE_MS,
    retryMaxDelayMs: env.PARTNERS_GATEWAY_WORKER_RETRY_MAX_MS,
  });
}

export function createPartnersGatewayClient(
  config: PartnersGatewayConfig,
  fetchImpl: typeof fetch = fetch,
) {
  if (!config.baseUrl) {
    throw new Error("PARTNERS_GATEWAY_URL is required");
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    ...(config.serviceToken ? { authorization: `Bearer ${config.serviceToken}` } : {}),
  };

  const gatewayRequest = (url: string, options: RequestInit = {}) => fetchImpl(url, {
    ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  return {
    async createJob(request: PartnersGatewayJobRequest): Promise<PartnersGatewayJob> {
      const response = await gatewayRequest(`${baseUrl}/v1/jobs`, {
        method: "POST",
        headers: {
          ...headers,
          ...(request.id ? { "idempotency-key": request.id } : {}),
        },
        body: JSON.stringify(request),
      });
      return parseGatewayJson<PartnersGatewayJob>(response);
    },

    async getJob(jobId: string): Promise<PartnersGatewayJob> {
      const response = await gatewayRequest(`${baseUrl}/v1/jobs/${jobId}`, { headers });
      return parseGatewayJson<PartnersGatewayJob>(response);
    },

    async listArtifacts(jobId: string): Promise<{ items: unknown[] }> {
      const response = await gatewayRequest(`${baseUrl}/v1/jobs/${jobId}/artifacts`, { headers });
      return parseGatewayJson<{ items: unknown[] }>(response);
    },

    async deleteSession(sessionId: string): Promise<void> {
      const response = await gatewayRequest(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok && response.status !== 404) {
        await parseGatewayJson(response);
      }
    },

    async syncWorkspaceFiles(
      sessionId: string,
      files: Array<{ path: string; content: string }>,
    ): Promise<{ written: string[]; totalBytes: number }> {
      const response = await gatewayRequest(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/workspace/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ files }),
      });
      return parseGatewayJson<{ written: string[]; totalBytes: number }>(response);
    },

    async health(): Promise<Record<string, unknown>> {
      const response = await gatewayRequest(`${baseUrl}/health`, { headers });
      if (!response.ok) return parseGatewayJson<Record<string, unknown>>(response);
      return response.json().catch(() => ({ status: "ok" })) as Promise<Record<string, unknown>>;
    },

    async *streamEvents(
      jobId: string,
      options: { signal?: AbortSignal; lastEventId?: string } = {},
    ): AsyncGenerator<PartnersGatewayEvent> {
      const response = await gatewayRequest(`${baseUrl}/v1/jobs/${jobId}/events`, {
        headers: {
          ...headers,
          accept: "text/event-stream",
          ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
        },
        signal: options.signal,
      });
      if (!response.ok) {
        await parseGatewayJson(response);
      }
      if (!response.body) throw new Error("Partners gateway event stream has no response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseGatewaySseEvent(block);
            if (event) yield event;
            boundary = buffer.indexOf("\n\n");
          }
          if (done) break;
        }
        const finalEvent = parseGatewaySseEvent(buffer);
        if (finalEvent) yield finalEvent;
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}

export function parseGatewaySseEvent(block: string): PartnersGatewayEvent | null {
  let id: string | undefined;
  let eventType: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "id") id = value;
    if (field === "event") eventType = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const parsed = JSON.parse(data.join("\n")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Partners gateway SSE data must be a JSON object");
  }
  const event = parsed as Record<string, unknown>;
  const sequence = typeof event.sequence === "number" ? event.sequence : Number(event.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Partners gateway SSE event requires a non-negative integer sequence");
  }
  return {
    ...event,
    id: id ?? (typeof event.id === "string" ? event.id : undefined),
    type: eventType ?? (typeof event.type === "string" ? event.type : "message"),
    sequence,
  } as PartnersGatewayEvent;
}

export function buildGatewayJobRequestFromTiRun(input: {
  run: PartnersGatewayTiRun;
  prompt: string;
  config: PartnersGatewayConfig;
  timeoutSeconds?: number;
  authority?: ExecutionDelegation;
}): PartnersGatewayJobRequest {
  return {
    id: `tw_ti_${input.run.id}`,
    tenantId: input.config.tenantId,
    projectId: input.config.projectId,
    executionMode: "ephemeral_interpreter",
    sessionId: input.run.sandboxSessionId ?? null,
    command: {
      argv: ["bash", "-lc", "cat \"$TASK_WEAVER_PROMPT_FILE\" && echo"],
      cwd: "/workspace",
      env: {
        TASK_WEAVER_PROMPT_FILE: "/workspace/task-weaver-prompt.txt",
      },
    },
    inputs: {
      files: [{
        path: "/workspace/task-weaver-prompt.txt",
        content: input.prompt,
      }],
    },
    timeoutSeconds: input.timeoutSeconds ?? input.config.defaultTimeoutSeconds,
    artifactPolicy: {
      collect: ["workspace:/workspace/task-weaver-review.json"],
    },
    metadata: {
      taskWeaver: {
        delegation: input.authority ? executionDelegationSchema.parse(input.authority) : null,
        tiAgentRunId: input.run.id,
        taskId: input.run.taskId ?? null,
        scheduleRunId: input.run.scheduleRunId ?? null,
        requestedProvider: input.run.requestedProvider ?? null,
        requestedModel: input.run.requestedModel ?? null,
      },
      prompt: input.prompt,
    },
  };
}

export function buildTiAgentRunPrompt(run: PartnersGatewayTiRun) {
  const lines = [
    "You are Ti, the bounded Task Weaver server-side agent.",
    "Execute only the explicitly assigned task below. Do not claim unrelated work, do not edit repositories unless the task explicitly requires it, and keep output concise.",
    "",
    `Run ID: ${run.id}`,
  ];
  if (run.task) {
    lines.push(`Task ID: ${run.task.id}`);
    lines.push(`Title: ${run.task.title}`);
    if (run.task.description) lines.push(`Description: ${run.task.description}`);
    lines.push(`Priority: ${run.task.priority}`);
  }
  if (run.scheduleRunId) lines.push(`Schedule Run ID: ${run.scheduleRunId}`);
  return lines.join("\n");
}

export function mapGatewayEventForTiRun(event: PartnersGatewayEvent) {
  return {
    sequence: event.sequence,
    type: event.type,
    at: event.at,
    state: event.state,
    chunk: typeof event.chunk === "string" ? event.chunk.slice(0, 4000) : undefined,
    artifact: event.artifact,
  };
}

export function buildTiCompletionFromGateway(input: {
  job: PartnersGatewayJob;
  events: PartnersGatewayEvent[];
  outputSummary?: string | null;
  errorMessage?: string | null;
  tokenUsageId?: string | null;
}): CompleteTiAgentRunInput {
  const status = mapGatewayStateToTiStatus(input.job.state);
  return {
    status,
    actualProvider: "partners-gateway",
    actualModel: input.job.provider ?? null,
    sandboxSessionId: input.job.id,
    tokenUsageId: input.tokenUsageId ?? null,
    eventLog: input.events.map(mapGatewayEventForTiRun),
    outputSummary: input.outputSummary ?? summarizeGatewayEvents(input.events),
    errorMessage: input.errorMessage ?? (status === "failed" ? input.job.terminalReason ?? "Gateway job failed" : null),
    costMetadata: {
      gatewayJobId: input.job.id,
      artifactCount: input.job.artifactCount ?? 0,
      exitCode: input.job.exitCode ?? null,
    },
  };
}

export function normalizeGatewayArtifactReferences(items: unknown[]) {
  const allowedFields = ["id", "name", "path", "uri", "url", "size", "contentType", "sha256"] as const;
  return items.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const reference: Record<string, string | number> = {};
    for (const field of allowedFields) {
      const value = source[field];
      if (typeof value === "string") reference[field] = value.slice(0, 2000);
      if (typeof value === "number" && Number.isFinite(value)) reference[field] = value;
    }
    return Object.keys(reference).length > 0 ? [reference] : [];
  });
}

export function isTransientGatewayError(error: unknown) {
  if (error instanceof PartnersGatewayError) {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500;
  }
  return error instanceof TypeError;
}

function mapGatewayStateToTiStatus(state: PartnersGatewayJob["state"]): CompleteTiAgentRunInput["status"] {
  if (state === "succeeded") return "succeeded";
  if (state === "cancelled") return "cancelled";
  if (state === "failed" || state === "timed_out") return "failed";
  return "in_review";
}

function summarizeGatewayEvents(events: PartnersGatewayEvent[]) {
  const stdout = events
    .filter((event) => event.type === "log.stdout" && typeof event.chunk === "string")
    .map((event) => event.chunk)
    .join("");
  return stdout.trim().slice(0, 8000) || null;
}

async function parseGatewayJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    const message = `Partners gateway HTTP ${response.status}`;
    throw new PartnersGatewayError(message, response.status);
  }
  return body as T;
}
