import { Hono } from "hono";
import {
  createResourceServices,
  personalResourceOwnerId,
  searchDocumentsSchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";
import { z } from "zod";

const search = new Hono<Env>();

type SearchItem = Record<string, unknown> | { value: unknown };

export function searchItemsResponse<T>(items: T[]): { items: T[] } {
  return { items };
}

export function typedSearchItems(type: string, rows: unknown[]): SearchItem[] {
  return rows.map((item) => ({
    ...(item && typeof item === "object" ? (item as Record<string, unknown>) : { value: item }),
    type,
  }));
}

// GET /documents - Search documents (supports mode=keyword|fulltext|hybrid|semantic)
search.get("/documents", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = searchDocumentsSchema.safeParse({
    ...query,
    personalOwnerId: query.personalOwnerId ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: query.personalOwnerType ?? "human",
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const results = await createResourceServices(c.get("identity")).documentService.searchDocumentsWithMetadata(db, parsed.data);
    return c.json({ items: results.items, metadata: results.metadata });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /documents/fulltext - Search documents using full-text search (tsvector)
// Kept for backward compatibility — equivalent to ?mode=fulltext on /documents
search.get("/documents/fulltext", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = searchDocumentsSchema.safeParse({
    ...query,
    mode: "fulltext",
    personalOwnerId: query.personalOwnerId ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: query.personalOwnerType ?? "human",
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const results = await createResourceServices(c.get("identity")).documentService.searchDocuments(db, parsed.data);
    return c.json(searchItemsResponse(results));
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /tasks - Search tasks
search.get("/tasks", async (c) => {
  const db = c.get("db");
  const q = c.req.query("q");
  const projectId = c.req.query("projectId");
  const scope = c.req.query("scope") as "project" | "personal" | undefined;

  if (!q || q.trim().length === 0) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const results = await createResourceServices(c.get("identity")).taskService.searchTasks(db, {
    query: q,
    projectId: projectId || undefined,
    scope: scope ?? (projectId ? "project" : "personal"),
    personalOwnerId: c.req.query("personalOwnerId") ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: (c.req.query("personalOwnerType") as "human" | "agent" | undefined) ?? "human",
    limit: 20,
  });

  return c.json(searchItemsResponse(results));
});

// GET /requirements - Search requirements
search.get("/requirements", async (c) => {
  const db = c.get("db");
  const q = c.req.query("q");
  const projectId = c.req.query("projectId");

  if (!q || q.trim().length === 0) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const results = await createResourceServices(c.get("identity")).requirementService.searchRequirements(db, {
    query: q,
    projectId: projectId || undefined,
    limit: 20,
  });

  return c.json(searchItemsResponse(results));
});

// GET /repositories - Search the visible repository catalog
search.get("/repositories", async (c) => {
  const q = c.req.query("q");
  if (!q || q.trim().length === 0) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }
  const pageSize = Math.min(Number(c.req.query("limit") ?? "20"), 100);
  const result = await createResourceServices(c.get("identity")).repositoryService.listRepositories(c.get("db"), {
    query: q,
    sort: "relevance",
    page: 1,
    pageSize,
  }, c.get("actor"));
  return c.json(searchItemsResponse(result.items));
});

// POST /resolve-titles - Resolve document titles to IDs (for wiki-links)
search.post("/resolve-titles", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  const parsed = z
    .object({ titles: z.array(z.string().min(1)).min(1).max(50) })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await createResourceServices(c.get("identity")).documentService.resolveDocumentTitles(db, parsed.data.titles);
  return c.json(results);
});

// GET /all - Combined search across tasks and documents
search.get("/all", async (c) => {
  const db = c.get("db");
  const q = c.req.query("q");
  const projectId = c.req.query("projectId");
  const includePersonal = c.req.query("includePersonal") === "true";
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  if (!q || q.trim().length === 0) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const [matchedTasks, matchedRequirements, matchedDocs, matchedRepositories] = await Promise.all([
    createResourceServices(c.get("identity")).taskService.searchTasks(db, {
      query: q,
      projectId: projectId || undefined,
      scope: projectId ? "project" : "personal",
      personalOwnerId: personalResourceOwnerId(c.get("identity")),
      personalOwnerType: "human",
      limit,
    }),
    createResourceServices(c.get("identity")).requirementService.searchRequirements(db, { query: q, projectId: projectId || undefined, limit }),
    createResourceServices(c.get("identity")).documentService.searchDocuments(db, {
      query: q,
      mode: "keyword",
      projectId: projectId || undefined,
      includeGlobal: true,
      includePersonal,
      personalOwnerId: personalResourceOwnerId(c.get("identity")),
      personalOwnerType: "human",
      limit,
      keywordWeight: 0.3,
      fulltextWeight: 0.7,
    }),
    Promise.resolve({ items: [] }),
  ]);

  return c.json({
    items: [
      ...typedSearchItems("task", matchedTasks),
      ...typedSearchItems("requirement", matchedRequirements),
      ...typedSearchItems("document", matchedDocs),
      ...typedSearchItems("repository", matchedRepositories.items),
    ],
    tasks: matchedTasks,
    requirements: matchedRequirements,
    documents: matchedDocs,
    repositories: matchedRepositories.items,
  });
});

export default search;
