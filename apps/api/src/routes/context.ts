import { Hono, type Context } from "hono";
import {
  createResourceServices,
  personalResourceOwnerId,
  skillPackageStorageService,
  searchContextSchema,
  importSkillSchema,
  registerSkillPackageSchema,
  listSkillPackagesSchema,
  getSkillPackageSchema,
  listSkillPackageFilesSchema,
  readSkillPackageFileSchema,
  downloadSkillPackageSchema,
  verifySkillPackageStorageSchema,
  reindexSkillPackageSchema,
  updateSkillPackageMetadataSchema,
  updateSkillPackageVersionStatusSchema,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";
import { z } from "zod";
import { resolve } from "node:path";

const context = new Hono<Env>();

function createSkillPackageStorage() {
  const baseDir = process.env.SKILL_PACKAGE_STORAGE_DIR
    ?? resolve(process.cwd(), "data", "skill-packages");
  const maxObjectBytes = process.env.SKILL_PACKAGE_MAX_OBJECT_BYTES
    ? Number(process.env.SKILL_PACKAGE_MAX_OBJECT_BYTES)
    : undefined;
  return new skillPackageStorageService.LocalSkillPackageStorageAdapter(baseDir, { maxObjectBytes });
}

function handleSkillPackageError(c: Context, err: unknown) {
  if (err instanceof NotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof ConflictError) {
    return c.json({ error: err.message, currentVersion: err.currentVersion }, 409);
  }
  throw err;
}

// GET /search - Search skills by intent
context.get("/search", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = searchContextSchema.safeParse({
    intent: query.intent ?? query.q,
    tags: query.tags ? query.tags.split(",") : undefined,
    limit: query.limit,
    mode: query.mode,
    projectId: query.projectId,
    includeGlobal: query.includeGlobal,
    includePersonal: query.includePersonal,
    personalOwnerId: query.personalOwnerId ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: query.personalOwnerType ?? "human",
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await createResourceServices(c.get("identity")).contextService.searchContext(db, parsed.data);
  return c.json({ items: results });
});

// GET /bootstrap - Get bootstrap context (minimal starting info)
context.get("/bootstrap", async (c) => {
  const bootstrap = await createResourceServices(c.get("identity")).contextService.getBootstrapContext();
  return c.json(bootstrap);
});

// GET /list - List all available skills
context.get("/list", async (c) => {
  const db = c.get("db");
  const tags = c.req.query("tags")?.split(",");
  const projectId = c.req.query("projectId");
  const allProjects = c.req.query("allProjects") === "true";
  const includePersonal = c.req.query("includePersonal") === "true";

  const results = await createResourceServices(c.get("identity")).contextService.listSkills(db, {
    tags,
    projectId: projectId || undefined,
    allProjects,
    includePersonal,
    personalOwnerId: c.req.query("personalOwnerId") ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: (c.req.query("personalOwnerType") as "human" | "agent" | undefined) ?? "human",
  });
  return c.json({ items: results });
});

// GET /packages - List registered skill packages
context.get("/packages", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const hasProjectScope = Boolean(query.projectId || query.allProjects === "true");
  const parsed = listSkillPackagesSchema.safeParse({
    ...query,
    personalOwnerId: query.personalOwnerId ?? (hasProjectScope ? undefined : personalResourceOwnerId(c.get("identity"))),
    personalOwnerType: query.personalOwnerType ?? (hasProjectScope ? undefined : "human"),
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await createResourceServices(c.get("identity")).skillPackageService.listPackages(db, parsed.data);
  return c.json(result);
});

// POST /packages/register - Register or update a package from uploaded file content
context.post("/packages/register", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = registerSkillPackageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.registerPackage(
      db,
      parsed.data,
      actor,
      createSkillPackageStorage(),
    );
    return c.json(result, 201);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /packages/:packageId - Inspect package manifest, versions, and files
context.get("/packages/:packageId", async (c) => {
  const db = c.get("db");
  const parsed = getSkillPackageSchema.safeParse({ packageId: c.req.param("packageId") });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.getPackage(db, parsed.data.packageId);
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /packages/:packageId/files - List file metadata for a package version
context.get("/packages/:packageId/files", async (c) => {
  const db = c.get("db");
  const parsed = listSkillPackageFilesSchema.safeParse({
    packageId: c.req.param("packageId"),
    version: c.req.query("version") || undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.listPackageFiles(db, parsed.data);
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /packages/:packageId/download - Download a manifest-backed package payload
context.get("/packages/:packageId/download", async (c) => {
  const db = c.get("db");
  const parsed = downloadSkillPackageSchema.safeParse({
    packageId: c.req.param("packageId"),
    version: c.req.query("version") || undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.downloadPackage(
      db,
      parsed.data,
      createSkillPackageStorage(),
    );
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /packages/:packageId/health - Verify package storage objects and hashes
context.get("/packages/:packageId/health", async (c) => {
  const db = c.get("db");
  const parsed = verifySkillPackageStorageSchema.safeParse({
    packageId: c.req.param("packageId"),
    version: c.req.query("version") || undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.verifyPackageStorage(
      db,
      parsed.data,
      createSkillPackageStorage(),
    );
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// POST /packages/:packageId/reindex - Rebuild indexed skill documents from readable package files
context.post("/packages/:packageId/reindex", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));
  const parsed = reindexSkillPackageSchema.safeParse({
    ...body,
    packageId: c.req.param("packageId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.reindexPackageTextFiles(
      db,
      parsed.data,
      actor,
      createSkillPackageStorage(),
    );
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /packages/:packageId/read - Read SKILL.md or another readable text file by path
context.get("/packages/:packageId/read", async (c) => {
  const db = c.get("db");
  const parsed = readSkillPackageFileSchema.safeParse({
    packageId: c.req.param("packageId"),
    version: c.req.query("version") || undefined,
    path: c.req.query("path") || "SKILL.md",
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.readPackageTextFile(
      db,
      parsed.data,
      createSkillPackageStorage(),
    );
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// PATCH /packages/:packageId - Update package metadata/status
context.patch("/packages/:packageId", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = updateSkillPackageMetadataSchema.safeParse({
    ...body,
    packageId: c.req.param("packageId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.updatePackageMetadata(db, parsed.data, actor);
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// PATCH /packages/:packageId/versions/:version - Deprecate/archive/restore a version
context.patch("/packages/:packageId/versions/:version", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = updateSkillPackageVersionStatusSchema.safeParse({
    ...body,
    packageId: c.req.param("packageId"),
    version: c.req.param("version"),
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).skillPackageService.updatePackageVersionStatus(db, parsed.data, actor);
    return c.json(result);
  } catch (err) {
    return handleSkillPackageError(c, err);
  }
});

// GET /:id - Get full skill content by ID
context.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const doc = await createResourceServices(c.get("identity")).documentService.getDocument(db, id);
    return c.json(doc);
  } catch {
    return c.json({ error: "Skill not found" }, 404);
  }
});

// POST /import - Import a single skill
context.post("/import", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = importSkillSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await createResourceServices(c.get("identity")).contextService.importSkill(db, parsed.data, actor);
  return c.json(result, 201);
});

// POST /import/batch - Import multiple skills
context.post("/import/batch", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = z.object({
    skills: z.array(importSkillSchema).min(1).max(50),
  }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await createResourceServices(c.get("identity")).contextService.bulkImportSkills(db, parsed.data.skills, actor);
  return c.json({ items: results, count: results.length }, 201);
});

export default context;
