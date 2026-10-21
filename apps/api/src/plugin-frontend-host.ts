import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { type Database, pluginInstallations } from "@task-weaver/db";
import { pluginFrontendOriginsSchema, pluginManifestSchema, ValidationError, NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { capabilityDigest, resourceAuthority, resourcePredicate, canAccessResource, preparePluginWorker, configuredPluginWorker, renderPluginFrontend, skillPackageStorageService, type PluginFrontend, type PluginFrameBinding } from "@task-weaver/core";

type Ticket = { identity: VerifiedRequestContext; frontend: PluginFrontend; binding: PluginFrameBinding; expires: number; reads: number; revalidate(): Promise<void> };

/** A separate listener serves only trusted-rendered artifacts; no Core router, cookies or authorization headers are forwarded. */
export function createPluginFrontendHost(db: Database, env: NodeJS.ProcessEnv) {
  const parsed = pluginFrontendOriginsSchema.safeParse({ webOrigin: env.TW_PLUGIN_WEB_ORIGIN, apiOrigin: env.TW_AUTH_BASE_URL, artifactOrigin: env.TW_PLUGIN_ARTIFACT_ORIGIN });
  const origins = parsed.success ? parsed.data : undefined;
  const tickets = new Map<string, Ticket>();
  let server: Server | undefined;
  let ready = false;
  const configuration = () => ({ ...configuredPluginWorker(env.TW_PLUGIN_RUNTIME_PROFILES, env.TW_PLUGIN_PUBLISHER_KEYS, env.TW_PLUGIN_ALLOW_UNVERIFIED === "true"), frontendAvailable: ready });
  const artifactApp = new Hono();
  artifactApp.all("*", async c => {
    c.header("cache-control", "no-store");
    const url = new URL(c.req.url);
    if (!ready || !origins || c.req.method !== "GET" || c.req.header("host")?.toLowerCase() !== new URL(origins.artifactOrigin).host || url.search || !/^\/artifacts\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) return c.text("Not found", 404);
    const token = url.pathname.slice("/artifacts/".length), ticket = tickets.get(token);
    if (!ticket || ticket.expires <= Date.now() || ++ticket.reads > 4) { tickets.delete(token); return c.text("Not found", 404); }
    try {
      await ticket.revalidate();
      const rendered = renderPluginFrontend(ticket.frontend, ticket.binding);
      return new Response(rendered.html, { headers: rendered.headers });
    } catch { tickets.delete(token); return c.text("Not found", 404); }
  });
  const current = async (identity: VerifiedRequestContext, id: string) => {
    const authority = await resourceAuthority(db, identity);
    const [row] = await db.select().from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations)));
    if (!row || row.status !== "active") throw new NotFoundError("Active plugin not found");
    return { row, authority };
  };
  return {
    configuration,
    available: () => ready,
    viewerUrl: (id: string) => ready && origins ? `${origins.webOrigin}/plugins/${id}` : null,
    async start() {
      if (ready || !origins) return;
      const port = Number(env.TW_PLUGIN_ARTIFACT_PORT ?? 3010), hostname = env.TW_PLUGIN_ARTIFACT_BIND ?? "127.0.0.1";
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      try {
        server = serve({ fetch: artifactApp.fetch, port, hostname }) as Server;
        await once(server, "listening");
        ready = true;
      } catch { if (server) { const failed = server; await new Promise<void>(resolve => failed.close(() => resolve())); } server = undefined; ready = false; }
    },
    async stop() {
      ready = false; tickets.clear();
      if (server) {
        const current = server; server = undefined;
        current.closeAllConnections();
        await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
      }
    },
    async issue(identity: VerifiedRequestContext, id: string, signal: AbortSignal) {
      if (!ready || !origins) throw new ValidationError("The dedicated plugin artifact host is unavailable");
      const { row, authority } = await current(identity, id);
      const manifest = pluginManifestSchema.parse(row.manifest);
      if (manifest.pluginId !== row.pluginId || capabilityDigest(manifest) !== row.manifestHash) throw new ValidationError("Plugin installation manifest integrity failed");
      if (!manifest.frontend || !manifest.permissions.includes("ui.render")) throw new ValidationError("This plugin has no isolated page");
      const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(env.SKILL_PACKAGE_STORAGE_DIR ?? process.env.SKILL_PACKAGE_STORAGE_DIR ?? resolve(process.cwd(), "data", "skill-packages"));
      const execution = await preparePluginWorker(db, identity, manifest, storage, configuration, signal);
      try {
        if (!execution.frontend) throw new ValidationError("Plugin frontend is unavailable");
        const binding: PluginFrameBinding = {
          installationId: row.id, revision: row.revision, manifestHash: row.manifestHash,
          bridgeNonce: randomBytes(32).toString("base64url"), webOrigin: origins.webOrigin,
          allowedMethods: canAccessResource(authority, row, "mcp.invoke") ? manifest.methods.filter(method => method.access === "read" || canAccessResource(authority, row, "resource.write")).map(method => method.name) : [],
        };
        const revalidateWorker = execution.revalidate;
        const revalidate = async () => {
          const live = await current(identity, id);
          if (!ready || live.row.revision !== binding.revision || live.row.manifestHash !== binding.manifestHash) throw new NotFoundError("Plugin viewer generation changed");
          await revalidateWorker(undefined, AbortSignal.timeout(5000));
        };
        await revalidate(); signal.throwIfAborted();
        for (const [token, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(token);
        const actorTickets = [...tickets].filter(([, ticket]) => ticket.identity.actor.id === identity.actor.id);
        if (actorTickets.length >= 8) tickets.delete(actorTickets[0]![0]);
        if (tickets.size >= 256) throw new ValidationError("Plugin artifact host capacity is busy; retry explicitly later");
        const token = randomBytes(32).toString("base64url"), expires = Date.now() + 60000;
        tickets.set(token, { identity, frontend: execution.frontend, binding, expires, reads: 0, revalidate });
        return { ...binding, displayName: manifest.displayName, pluginId: manifest.pluginId, artifactUrl: `${origins.artifactOrigin}/artifacts/${token}`, expiresAt: new Date(expires).toISOString(), frontendFormat: "restricted_html_v1" };
      } finally { await execution.dispose(); }
    },
  };
}
export type PluginFrontendHost = ReturnType<typeof createPluginFrontendHost>;
