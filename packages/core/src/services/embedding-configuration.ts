import type { Database, embeddingProfiles } from "@task-weaver/db";
import { getEmbeddingProfile } from "./embeddings/profiles";
import { createOpenAICompatibleEmbeddingProvider, resolveEmbeddingSecretReference } from "./embeddings/openai-compatible";

export function embeddingProvider(profile: typeof embeddingProfiles.$inferSelect) {
  return createOpenAICompatibleEmbeddingProvider({
    provider: "openai_compatible", baseUrl: profile.baseUrl, model: profile.model,
    dimensions: profile.dimensions, secretRef: profile.secretRef,
    timeoutMs: profile.timeoutMs, batchSize: profile.batchSize,
  }, { resolveSecret: resolveEmbeddingSecretReference });
}

export async function testEmbeddingProfile(db: Database, profileId: string) {
  const profile = await getEmbeddingProfile(db, profileId);
  return { ok: true, capabilities: await embeddingProvider(profile).validateConfiguration() };
}
