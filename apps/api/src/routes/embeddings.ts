import { Hono } from "hono";
import type { Context } from "hono";
import {
  ConflictError,
  EmbeddingProviderError,
  NotFoundError,
  ValidationError,
  createEmbeddingProfileSchema,
  embeddingJobKindSchema,
  embeddingService,
  listEmbeddingProfilesSchema,
  updateEmbeddingProfileSchema,
  createOpenAICompatibleEmbeddingProvider,
  resolveEmbeddingSecretReference,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const embeddings = new Hono<Env>();

function providerForProfile(profile: Awaited<ReturnType<typeof embeddingService.getEmbeddingProfile>>) {
  return createOpenAICompatibleEmbeddingProvider({
    provider: "openai_compatible",
    baseUrl: profile.baseUrl,
    model: profile.model,
    dimensions: profile.dimensions,
    secretRef: profile.secretRef,
    timeoutMs: profile.timeoutMs,
    batchSize: profile.batchSize,
  }, { resolveSecret: resolveEmbeddingSecretReference });
}

function errorResponse(c: Context<Env>, error: unknown) {
  if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof ConflictError) return c.json({ error: error.message, currentVersion: error.currentVersion }, 409);
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  if (error instanceof EmbeddingProviderError) {
    const status = error.code === "authentication" || error.code === "permission" ? 502
      : error.code === "invalid_config" || error.code === "invalid_request" ? 400
        : error.code === "rate_limited" ? 429
          : 503;
    return c.json({ error: error.message, code: error.code, retryAfterMs: error.retryAfterMs }, status);
  }
  throw error;
}

// GET /profiles — list profiles, with optional scope/status filtering.
embeddings.get("/profiles", async (c) => {
  const parsed = listEmbeddingProfilesSchema.safeParse({
    projectId: c.req.query("projectId") || undefined,
    includeGlobal: c.req.query("includeGlobal") !== "false",
    includePersonal: c.req.query("includePersonal") === "true",
    personalOwnerId: c.req.query("personalOwnerId") || c.get("actor").id,
    personalOwnerType: c.req.query("personalOwnerType") || c.get("actor").type,
    includeDisabled: c.req.query("includeDisabled") !== "false",
  });
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);

  const profiles = await embeddingService.listEmbeddingProfiles(c.get("db"));
  const items = profiles.filter((profile) => {
    if (!parsed.data.includeDisabled && profile.status === "disabled") return false;
    if (profile.scope === "global") return parsed.data.includeGlobal;
    if (profile.scope === "project") return Boolean(parsed.data.projectId) && profile.projectId === parsed.data.projectId;
    return parsed.data.includePersonal
      && profile.personalOwnerId === parsed.data.personalOwnerId
      && profile.personalOwnerType === parsed.data.personalOwnerType;
  });
  return c.json({ items });
});

// POST /profiles — create a disabled profile. Enable performs provider validation first.
embeddings.post("/profiles", async (c) => {
  const parsed = createEmbeddingProfileSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    const profile = await embeddingService.createEmbeddingProfile(c.get("db"), parsed.data, c.get("actor"));
    return c.json(profile, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/profiles/:id", async (c) => {
  try {
    return c.json(await embeddingService.getEmbeddingProfile(c.get("db"), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.patch("/profiles/:id", async (c) => {
  const parsed = updateEmbeddingProfileSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    const profile = await embeddingService.updateEmbeddingProfile(c.get("db"), c.req.param("id"), parsed.data, c.get("actor"));
    return c.json(profile);
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/profiles/:id/test", async (c) => {
  try {
    const profile = await embeddingService.getEmbeddingProfile(c.get("db"), c.req.param("id"));
    const capabilities = await providerForProfile(profile).validateConfiguration();
    return c.json({ ok: true, capabilities });
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/profiles/:id/enable", async (c) => {
  try {
    const profile = await embeddingService.getEmbeddingProfile(c.get("db"), c.req.param("id"));
    const updated = await embeddingService.enableEmbeddingProfile(c.get("db"), profile.id, c.get("actor"), providerForProfile(profile));
    return c.json(updated);
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/profiles/:id/disable", async (c) => {
  try {
    return c.json(await embeddingService.setEmbeddingProfileStatus(c.get("db"), c.req.param("id"), "disabled", c.get("actor")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/profiles/:id/preview", async (c) => {
  try {
    return c.json(await embeddingService.previewEmbeddingRebuild(c.get("db"), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/profiles/:id/usage", async (c) => {
  try {
    await embeddingService.getEmbeddingProfile(c.get("db"), c.req.param("id"));
    return c.json(await embeddingService.getEmbeddingUsage(c.get("db"), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/profiles/:id/generations", async (c) => {
  try {
    return c.json({ items: await embeddingService.listEmbeddingGenerations(c.get("db"), c.req.param("id")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/profiles/:id/rebuild", async (c) => {
  const rawBody: unknown = await c.req.json().catch(() => ({}));
  const requestedKind = rawBody && typeof rawBody === "object" && "kind" in rawBody
    ? (rawBody as { kind?: unknown }).kind
    : "full";
  const parsed = embeddingJobKindSchema.safeParse(requestedKind);
  if (!parsed.success || parsed.data === "incremental") {
    return c.json({ error: "Validation error", details: "rebuild kind must be full or forced" }, 400);
  }
  try {
    return c.json(await embeddingService.startEmbeddingRebuild(c.get("db"), c.req.param("id"), parsed.data, c.get("actor")), 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/profiles/:id/cleanup", async (c) => {
  try {
    return c.json({ deletedGenerations: await embeddingService.cleanupRetiredEmbeddingGenerations(c.get("db"), c.req.param("id")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/jobs/:id", async (c) => {
  try {
    return c.json(await embeddingService.getEmbeddingJob(c.get("db"), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.get("/jobs/:id/items", async (c) => {
  try {
    return c.json({ items: await embeddingService.listEmbeddingJobItems(c.get("db"), c.req.param("id")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/jobs/:id/cancel", async (c) => {
  try {
    return c.json(await embeddingService.requestEmbeddingJobCancellation(c.get("db"), c.req.param("id"), c.get("actor").id));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/jobs/:id/resume", async (c) => {
  try {
    return c.json(await embeddingService.resumeEmbeddingJob(c.get("db"), c.req.param("id"), c.get("actor").id));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/jobs/:id/retry-failed", async (c) => {
  try {
    return c.json(await embeddingService.retryFailedEmbeddingJobItems(c.get("db"), c.req.param("id"), c.get("actor").id));
  } catch (error) {
    return errorResponse(c, error);
  }
});

embeddings.post("/generations/:id/activate", async (c) => {
  try {
    return c.json(await embeddingService.markEmbeddingGenerationActive(c.get("db"), c.req.param("id"), c.get("actor")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default embeddings;
