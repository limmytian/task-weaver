import { Hono } from "hono";
import {
  documentService,
  recommendationService,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
  linkDocumentsSchema,
  linkDocumentToTaskSchema,
  listDocumentVersionsSchema,
  compareDocumentVersionsSchema,
  revertDocumentSchema,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const documents = new Hono<Env>();

// GET / - List documents with optional filters
documents.get("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();

  const parsed = listDocumentsSchema.safeParse({
    ...query,
    personalOwnerId: query.personalOwnerId ?? actor.id,
    personalOwnerType: query.personalOwnerType ?? actor.type,
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const result = await documentService.listDocuments(db, parsed.data);
  return c.json(result);
});

// POST / - Create a document
documents.post("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = createDocumentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const doc = await documentService.createDocument(db, parsed.data, actor);
    return c.json(doc, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /:id - Get document detail with backlinks
documents.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const doc = await documentService.getDocumentDetail(db, id);
    return c.json(doc);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// PATCH /:id - Update document
documents.patch("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateDocumentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const doc = await documentService.updateDocument(db, id, parsed.data, actor);
    return c.json(doc);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// DELETE /:id - Delete document
documents.delete("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    await documentService.deleteDocument(db, id, actor);
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/versions - List document version history
documents.get("/:id/versions", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const query = c.req.query();

  const parsed = listDocumentVersionsSchema.safeParse({ ...query, documentId: id });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const versions = await documentService.listDocumentVersions(db, parsed.data);
    return c.json(versions);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/versions/compare - Compare two versions
documents.get("/:id/versions/compare", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const query = c.req.query();

  const parsed = compareDocumentVersionsSchema.safeParse({ ...query, documentId: id });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await documentService.compareDocumentVersions(db, parsed.data);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/versions/:version - Get specific version content
documents.get("/:id/versions/:version", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const version = parseInt(c.req.param("version"), 10);

  if (isNaN(version) || version < 1) {
    return c.json({ error: "Invalid version number" }, 400);
  }

  try {
    const result = await documentService.getDocumentVersion(db, id, version);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /:id/revert - Revert document to a specific version
documents.post("/:id/revert", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = revertDocumentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const doc = await documentService.revertDocument(db, id, parsed.data, actor);
    return c.json(doc);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/backlinks - Get backlinks for a document
documents.get("/:id/backlinks", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const backlinks = await documentService.getBacklinks(db, id);
  return c.json(backlinks);
});

// POST /:id/links - Link to another document
documents.post("/:id/links", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = linkDocumentsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const link = await documentService.linkDocuments(
      db,
      id,
      parsed.data.targetDocId,
      parsed.data.linkType,
      actor,
      parsed.data.context,
    );
    return c.json(link, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// POST /:id/task-links - Link document to a task
documents.post("/:id/task-links", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = linkDocumentToTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const link = await documentService.linkDocumentToTask(
      db,
      id,
      parsed.data.taskId,
      parsed.data.linkType,
      actor,
    );
    return c.json(link, 201);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// DELETE /:id/links/:linkId - Remove document-to-document link
documents.delete("/:id/links/:linkId", async (c) => {
  const linkId = c.req.param("linkId");

  try {
    const deleted = await documentService.unlinkDocuments(c.get("db"), linkId);
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /:id/task-links/:linkId - Remove document-to-task link
documents.delete("/:id/task-links/:linkId", async (c) => {
  const linkId = c.req.param("linkId");

  try {
    const deleted = await documentService.unlinkDocumentFromTask(c.get("db"), linkId);
    return c.json(deleted);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/recommendations - Get recommended links for a document
documents.get("/:id/recommendations", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const query = c.req.query();

  const limit = query.limit ? Number(query.limit) : undefined;
  const types = query.types
    ? (query.types.split(",") as ("document" | "task" | "requirement")[])
    : undefined;
  const threshold = query.threshold ? Number(query.threshold) : undefined;

  try {
    const result = await recommendationService.getDocumentRecommendations(
      db,
      id,
      { limit, types, projectId: query.projectId, threshold },
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

export default documents;
