import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { resolve } from "node:path";
import { and, eq, isNull, desc } from "drizzle-orm";
import { pluginGenerations, pluginInstallations } from "@task-weaver/db";
import { createPluginLifecycle, preparePluginWorker, invokeInstalledPlugin, configuredPluginWorker, recoverPluginSchema, personalResourceOwnerId, skillPackageStorageService, ValidationError, NotFoundError, ConflictError } from "@task-weaver/core";
import { resourceAuthority, resourcePredicate } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const routes = new Hono<Env>();
routes.use("*", bodyLimit({ maxSize: 131072, onError: c => c.json({ error: "Plugin request exceeds the 131072-byte limit" }, 413) }));
const idSchema = z.string().uuid();
const querySchema = z.object({ projectId: z.string().uuid().optional(), scope: z.enum(["project", "personal", "global"]).default("personal"), limit: z.coerce.number().int().min(1).max(20).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().refine(value => value.scope === "project" ? !!value.projectId : !value.projectId, "Project scope requires projectId");

routes.onError((error, c) => {
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON request" }, 400);
  if (error instanceof z.ZodError) return c.json({ error: "Invalid plugin request", details: error.flatten() }, 400);
  if (error instanceof ConflictError) return c.json({ error: error.message, currentVersion: error.currentVersion }, 409);
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  if (error instanceof NotFoundError) return c.json({ error: "Resource not found" }, 404);
  throw error;
});

routes.get("/", async c => {
  const query = querySchema.parse(c.req.query()), db = c.get("db"), identity = c.get("identity");
  const authority = await resourceAuthority(db, identity);
  const scope = query.scope === "project" ? eq(pluginInstallations.projectId, query.projectId!) : query.scope === "personal" ? and(isNull(pluginInstallations.projectId), eq(pluginInstallations.personalOwnerId, personalResourceOwnerId(identity))) : and(isNull(pluginInstallations.projectId), isNull(pluginInstallations.personalOwnerId));
  const items = await db.select({ id: pluginInstallations.id, pluginId: pluginInstallations.pluginId, revision: pluginInstallations.revision, status: pluginInstallations.status, manifestHash: pluginInstallations.manifestHash }).from(pluginInstallations).where(and(resourcePredicate(authority, pluginInstallations), scope)).orderBy(desc(pluginInstallations.updatedAt), pluginInstallations.id).limit(query.limit).offset(query.offset);
  return c.json({ items, limit: query.limit, offset: query.offset });
});

routes.get("/:id", async c => {
  const id = idSchema.parse(c.req.param("id")), db = c.get("db");
  const authority = await resourceAuthority(db, c.get("identity"));
  const [row] = await db.select().from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations)));
  if (!row) throw new NotFoundError("Resource not found");
  return c.json(row);
});

routes.get("/:id/generations", async c => {
  const id = idSchema.parse(c.req.param("id")), db = c.get("db");
  const authority = await resourceAuthority(db, c.get("identity"));
  const [row] = await db.select({ id: pluginInstallations.id }).from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations)));
  if (!row) throw new NotFoundError("Resource not found");
  const query = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().parse(c.req.query());
  const records = await db.select({ version: pluginGenerations.version, manifestHash: pluginGenerations.manifestHash, trust: pluginGenerations.trust, createdAt: pluginGenerations.createdAt }).from(pluginGenerations).where(eq(pluginGenerations.installationId, id)).orderBy(desc(pluginGenerations.createdAt), pluginGenerations.version).limit(query.limit).offset(query.offset);
  return c.json({ items: records.map(({ trust, ...record }) => ({ ...record, verifiedAtInstall: trust === "verified" })), ...query });
});

routes.get("/:id/generations/:version", async c => {
  const id = idSchema.parse(c.req.param("id")), version = recoverPluginSchema.shape.version.parse(c.req.param("version")), db = c.get("db");
  const authority = await resourceAuthority(db, c.get("identity"));
  const [row] = await db.select({ id: pluginInstallations.id }).from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations)));
  if (!row) throw new NotFoundError("Resource not found");
  const [record] = await db.select().from(pluginGenerations).where(and(eq(pluginGenerations.installationId, id), eq(pluginGenerations.version, version)));
  if (!record) throw new NotFoundError("Plugin generation not found");
  const { trust, ...data } = record;
  return c.json({ ...data, verifiedAtInstall: trust === "verified" });
});

routes.post("/", async c => {
  const db = c.get("db"), identity = c.get("identity"), configuration = c.get("pluginWorkerConfiguration") ?? (() => configuredPluginWorker());
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(process.env.SKILL_PACKAGE_STORAGE_DIR ?? resolve(process.cwd(), "data", "skill-packages"));
  const lifecycle = createPluginLifecycle(db, identity, configuration, (manifest, signal) => preparePluginWorker(db, identity, manifest, storage, configuration, signal));
  return c.json(await lifecycle.install(await c.req.json(), AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(25000)])), 201);
});

routes.post("/:id/:operation", async c => {
  const id = idSchema.parse(c.req.param("id")), operation = z.enum(["upgrade", "recover", "status", "invoke"]).parse(c.req.param("operation"));
  const db = c.get("db"), identity = c.get("identity"), configuration = c.get("pluginWorkerConfiguration") ?? (() => configuredPluginWorker());
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(process.env.SKILL_PACKAGE_STORAGE_DIR ?? resolve(process.cwd(), "data", "skill-packages"));
  const prepare = (manifest: Parameters<typeof preparePluginWorker>[2], signal: AbortSignal) => preparePluginWorker(db, identity, manifest, storage, configuration, signal);
  const lifecycle = createPluginLifecycle(db, identity, configuration, prepare), input = await c.req.json();
  const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(25000)]);
  if (operation === "invoke") return c.json(await invokeInstalledPlugin(db, identity, id, input, prepare, signal));
  if (operation === "status") return c.json(await lifecycle.changeStatus(id, input));
  return c.json(await lifecycle.activate(id, operation, input, signal));
});

export default routes;
