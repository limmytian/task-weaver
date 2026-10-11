import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentUsageRuns, type Database, type tiAgentModelConfigs } from "@task-weaver/db";
import { usageModelSnapshotSchema, type AgentUsageSummary, type Actor } from "@task-weaver/contracts";

export function snapshotChatModel(config: typeof tiAgentModelConfigs.$inferSelect, generation: { temperature?: number; maxTokens?: number }, secret = "", now = new Date()) {
  const safe = (value: string | null) => value && secret ? value.split(secret).join("[redacted]") : value;
  return usageModelSnapshotSchema.parse({
    version: 1, capturedAt: now.toISOString(), configurationId: config.id,
    configurationUpdatedAt: config.updatedAt.toISOString(), displayName: safe(config.label),
    provider: safe(config.provider), configuredModel: safe(config.model),
    generation: { ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }), ...(generation.maxTokens === undefined ? {} : { maxTokens: generation.maxTokens }) },
  });
}

/** Only provider-reported counters are retained; missing fields never become zero. */
export function providerChatUsage(value: unknown, actualModel?: unknown, secret = ""): AgentUsageSummary {
  const usage = value && typeof value === "object" ? value as Record<string, any> : {};
  const counter = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const inputTokens = counter(usage.prompt_tokens);
  const outputTokens = counter(usage.completion_tokens);
  const cacheReadTokens = counter(usage.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = counter(usage.prompt_tokens_details?.cache_write_tokens);
  const hasUsage = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(v => v !== null);
  const model = typeof actualModel === "string" && actualModel.length <= 160 && actualModel ? actualModel : "unknown";
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    cacheSemantics: cacheReadTokens !== null && (inputTokens === null || cacheReadTokens <= inputTokens) ? "included" : "unknown", provider: "unknown",
    model: secret ? model.split(secret).join("[redacted]") : model,
    completeness: inputTokens !== null && outputTokens !== null ? "complete" : hasUsage ? "partial" : "unknown" };
}

/** Server-only collector: each request receives an identity before contacting the provider. */
export async function beginChatUsage(db: Database, input: {
  projectId: string | null; requirementId: string | null; taskId: string | null;
  conversationId: string; messageId: string; operationIds: string[]; actor: Actor;
  snapshot: ReturnType<typeof snapshotChatModel>;
}) {
  const processId = randomUUID();
  await db.insert(agentUsageRuns).values({ processId, projectId: input.projectId,
    requirementId: input.requirementId, taskId: input.taskId,
    personalOwnerId: input.projectId ? null : input.actor.id,
    personalOwnerType: input.projectId ? null : input.actor.type,
    conversationId: input.conversationId, messageId: input.messageId,
    operationIds: input.operationIds, modelSnapshot: input.snapshot,
    source: input.operationIds.length ? "ti_operation" : "ti_chat", agent: "ti", phase: "execution",
    outcome: "running", startedAt: new Date(input.snapshot.capturedAt), revision: 0,
    summary: providerChatUsage(null), reportedBy: input.actor.id });
  let summary = providerChatUsage(null);
  return {
    observe(value: unknown, model?: unknown, secret = "") {
      const next = providerChatUsage(value, model, secret);
      summary = { ...(value == null ? summary : next), model: next.model === "unknown" ? summary.model : next.model };
    },
    async finish(outcome: "succeeded" | "failed" | "cancelled") {
      await db.update(agentUsageRuns).set({ outcome, endedAt: new Date(), revision: 1,
        summary: { ...summary, completeness: outcome !== "succeeded" && summary.completeness === "complete" ? "partial" : summary.completeness },
        updatedAt: new Date() }).where(eq(agentUsageRuns.processId, processId));
    },
  };
}
