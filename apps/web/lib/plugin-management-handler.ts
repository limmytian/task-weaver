import { z } from "zod";
import { authenticationFailure, AuthenticationError, ValidationError, capabilityDigest, pluginPermissionDiff } from "@task-weaver/core";
import { pluginListQuerySchema, pluginManifestReviewSchema, pluginManifestSchema, installPluginSchema, upgradePluginSchema, recoverPluginSchema, changePluginStatusSchema } from "@task-weaver/contracts";
import type { getWebAuthenticationRuntime } from "@/trpc/init";

async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ValidationError("Plugin request body is required");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 131072) { await reader.cancel(); throw new ValidationError("Plugin request exceeds its byte limit"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new ValidationError("Invalid plugin request JSON"); }
}

/** Human-session BFF: fixed API paths, live CSRF checks and no credential forwarding to artifacts. */
export function createPluginManagementHandler(getRuntime: typeof getWebAuthenticationRuntime, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch) {
  return async (request: Request, path: string[]) => {
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
    try {
      const { auth } = getRuntime();
      auth.assertOrigin(request.headers);
      const identity = await auth.verify(request.headers);
      if (identity.credential.kind !== "session" || identity.actor.type !== "human") throw new AuthenticationError();
      if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
      if (request.method === "POST") auth.authentication.assertMutation(request.headers);
      const api = new URL(env.TW_API_URL ?? "http://localhost:3001");
      if (!["http:", "https:"].includes(api.protocol) || api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw new ValidationError("Plugin API endpoint configuration is invalid");
      const headers = new Headers();
      for (const name of ["cookie", "origin", "x-csrf-token"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
      const upstream = async (suffix: string, body?: unknown) => {
        const forwarded = new Headers(headers);
        if (body !== undefined) forwarded.set("content-type", "application/json");
        const response = await fetchImpl(`${api.origin}/api/v1/plugins${suffix}`, { method: body === undefined ? "GET" : "POST", headers: forwarded, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) });
        if (!response.ok) {
          const status = [400, 401, 403, 404, 409, 413, 429, 503].includes(response.status) ? response.status : 502;
          let validationMessage: string | undefined;
          if (status === 400) { try { const failure = await response.json(); if (typeof failure.error === "string" && failure.error.length <= 500) validationMessage = failure.error; } catch { /* Non-JSON failures remain private. */ } }
          throw new UpstreamFailure(status, validationMessage ?? (status === 401 ? "Sign in again before managing plugins." : status === 409 ? "This installation changed. Refresh and review the current revision before retrying." : status === 403 ? "Your current permissions do not allow this operation." : status === 404 ? "The installation or generation is unavailable." : "The plugin operation could not be completed. Inspect the current state before retrying."));
        }
        return await response.json();
      };
      if (request.method === "POST" && path.length === 1 && path[0] === "review") {
        const input = pluginManifestReviewSchema.parse(await boundedJson(request));
        const current = input.installationId ? await upstream(`/${input.installationId}`) : undefined;
        if (current && current.pluginId !== input.manifest.pluginId) throw new ValidationError("Plugin identity cannot change");
        const previous = current ? pluginManifestSchema.parse(current.manifest) : { ...input.manifest, permissions: [], skillBindings: undefined, toolBindings: undefined };
        return json({ manifest: input.manifest, manifestHash: capabilityDigest(input.manifest), currentRevision: current?.revision ?? null, permissionDiff: pluginPermissionDiff(previous, input.manifest) });
      }
      let suffix = "";
      if (path.length) {
        const id = z.string().uuid().parse(path[0]); suffix = `/${id}`;
        if (path.length === 2 && request.method === "GET" && path[1] === "generations") suffix += "/generations";
        else if (path.length === 3 && request.method === "GET" && path[1] === "generations") suffix += `/generations/${encodeURIComponent(recoverPluginSchema.shape.version.parse(path[2]))}`;
        else if (path.length === 2 && request.method === "POST" && ["upgrade", "recover", "status"].includes(path[1]!)) suffix += `/${path[1]}`;
        else if (path.length !== 1 || request.method !== "GET") return json({ error: "Unknown plugin operation" }, 404);
      }
      let body: unknown;
      if (request.method === "POST") {
        const schema = !path.length ? installPluginSchema : path[1] === "upgrade" ? upgradePluginSchema : path[1] === "recover" ? recoverPluginSchema : changePluginStatusSchema;
        body = schema.parse(await boundedJson(request));
      } else if (!path.length) {
        const query = pluginListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
        suffix += `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
      } else if (path.length === 2) {
        const query = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
        suffix += `?limit=${query.limit}&offset=${query.offset}`;
      }
      const data = await upstream(suffix, body);
      if (request.method === "GET" && path.length === 1) return json({ id: data.id, pluginId: data.pluginId, revision: data.revision, status: data.status, manifestHash: data.manifestHash, manifest: pluginManifestSchema.parse(data.manifest), viewerAvailable: Boolean(data.viewerUrl) });
      return json(data);
    } catch (error) {
      if (error instanceof UpstreamFailure) return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return json({ error: "Invalid plugin request. Check the manifest, scope and revision." }, 400);
      const failure = authenticationFailure(error);
      return json({ error: failure.error, code: failure.code }, failure.status);
    }
  };
}
class UpstreamFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
