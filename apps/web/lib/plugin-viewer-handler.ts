import { authenticationFailure, AuthenticationError, ValidationError, invokePluginSchema, pluginViewerTicketSchema, pluginFrontendOriginsSchema, renderPluginViewer } from "@task-weaver/core";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { stableActorReferenceSchema } from "@task-weaver/contracts";
import type { getWebAuthenticationRuntime } from "@/trpc/init";

function viewerUnavailable(status: number) {
  const nonce = randomBytes(24).toString("base64");
  const message = status === 401 ? "Sign in to open this plugin." : status === 403 ? "Your current project role cannot open this plugin." : status === 404 ? "This plugin is unavailable or no longer active." : "The plugin service is unavailable. Check its configuration or try again later.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Plugin unavailable</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;background:#f6f8fb;color:#172033;padding:48px}main{max-width:640px;background:white;padding:32px;border:1px solid #dfe5ef;border-radius:12px}a{color:#285caa;margin-right:20px}</style></head><body><main><h1>Plugin unavailable</h1><p>${message}</p><a href="/projects">Back to Task Weaver</a><a href="/login">Sign in</a></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` } });
}

export function createPluginViewerHandler(getRuntime: typeof getWebAuthenticationRuntime, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch) {
  return async (request: Request, id: string, operation: "viewer" | "invoke") => {
    try {
      const { auth } = getRuntime();
      auth.assertOrigin(request.headers);
      const identity = await auth.verify(request.headers);
      if (identity.credential.kind !== "session" || identity.actor.type !== "human") throw new AuthenticationError();
      stableActorReferenceSchema.parse({ id, type: "human" });
      if (operation === "invoke") auth.authentication.assertMutation(request.headers);
      let body: string | undefined;
      if (operation === "invoke") {
        const reader = request.body?.getReader();
        if (!reader) throw new ValidationError("Plugin request body is required");
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); throw new ValidationError("Plugin request exceeds its byte limit"); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks);
        let raw: unknown;
        try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new ValidationError("Invalid plugin request JSON"); }
        body = JSON.stringify(invokePluginSchema.parse(raw));
      }
      const apiUrl = new URL(env.TW_API_URL ?? "http://localhost:3001");
      if (!["https:", "http:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/") throw new ValidationError("Plugin API endpoint configuration is invalid");
      const headers = new Headers();
      for (const name of ["cookie", "origin", "x-csrf-token"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
      if (body) headers.set("content-type", "application/json");
      const response = await fetchImpl(`${apiUrl.origin}/api/v1/plugins/${id}/${operation}`, { method: operation === "viewer" ? "GET" : "POST", headers, body, redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) });
      if (!response.ok && operation === "viewer") return viewerUnavailable(response.status);
      if (!response.ok) return Response.json({ error: "Plugin operation is unavailable for the current session or installation" }, { status: response.status, headers: { "cache-control": "no-store" } });
      const data: unknown = await response.json();
      if (operation === "invoke") return Response.json(data, { headers: { "cache-control": "no-store" } });
      const ticket = pluginViewerTicketSchema.parse(data);
      const requestHost = request.headers.get("host")?.toLowerCase() ?? new URL(request.url).host;
      if (!auth.trustedOrigins.has(ticket.webOrigin) || requestHost !== new URL(ticket.webOrigin).host) {
        console.warn("Plugin viewer origin mismatch", { requestHost, configuredHost: new URL(ticket.webOrigin).host, trustedOrigin: auth.trustedOrigins.has(ticket.webOrigin) });
        throw new ValidationError("Plugin viewer origin does not match the current application");
      }
      pluginFrontendOriginsSchema.parse({ webOrigin: ticket.webOrigin, apiOrigin: new URL(env.TW_AUTH_BASE_URL ?? apiUrl.origin).origin, artifactOrigin: new URL(ticket.artifactUrl).origin });
      const rendered = renderPluginViewer(ticket);
      return new Response(rendered.html, { headers: rendered.headers });
    } catch (error) {
      console.warn("Plugin viewer request rejected", error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path, code: issue.code })) : { reason: error instanceof ValidationError ? error.message : "unavailable" });
      const failure = authenticationFailure(error);
      if (operation === "viewer") return viewerUnavailable(failure.status);
      return Response.json({ error: failure.error, code: failure.code }, { status: failure.status, headers: { "cache-control": "no-store" } });
    }
  };
}
