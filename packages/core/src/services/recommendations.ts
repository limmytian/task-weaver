import { documentSearchVector } from "./search-vector";
import type { RetrievalPredicates } from "./retrieval-predicates";
import { and, eq, or, isNull, sql, ne, notInArray } from "drizzle-orm";
import {
  type Database,
  documents,
  documentLinks,
  documentTaskLinks,
  documentRequirementLinks,
  tasks,
  requirements,
} from "@task-weaver/db";
import { NotFoundError } from "@task-weaver/contracts";

interface RecommendationItem {
  id: string;
  type: "document" | "task" | "requirement";
  title: string;
  score: number;
  reason: string;
}

interface RecommendationsResult {
  entityId: string;
  entityType: string;
  recommendations: RecommendationItem[];
}

/**
 * Build a tsquery string from text (words joined by &).
 */
function buildTsQuery(text: string): string | null {
  const q = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, ""))
    .filter((w) => w.length > 1)
    .slice(0, 20) // Limit to 20 terms
    .join(" | "); // Use OR for broader matching
  return q || null;
}

/**
 * Get existing linked document IDs for a document (both directions).
 */
async function getLinkedDocIds(db: Database, docId: string): Promise<string[]> {
  const outgoing = await db
    .select({ id: documentLinks.targetDocId })
    .from(documentLinks)
    .where(eq(documentLinks.sourceDocId, docId));
  const incoming = await db
    .select({ id: documentLinks.sourceDocId })
    .from(documentLinks)
    .where(eq(documentLinks.targetDocId, docId));
  return [...outgoing.map((r) => r.id), ...incoming.map((r) => r.id)];
}

/**
 * Get existing linked task IDs for a document.
 */
async function getLinkedTaskIds(
  db: Database,
  docId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: documentTaskLinks.taskId })
    .from(documentTaskLinks)
    .where(eq(documentTaskLinks.documentId, docId));
  return rows.map((r) => r.id);
}

/**
 * Get existing linked requirement IDs for a document.
 */
async function getLinkedReqIds(
  db: Database,
  docId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: documentRequirementLinks.requirementId })
    .from(documentRequirementLinks)
    .where(eq(documentRequirementLinks.documentId, docId));
  return rows.map((r) => r.id);
}

/**
 * Get recommendations for a document.
 * Finds similar documents (via tsvector), tasks, and requirements using text matching.
 */
export async function getDocumentRecommendations(
  db: Database,
  documentId: string,
  options?: {
    limit?: number;
    types?: ("document" | "task" | "requirement")[];
    projectId?: string;
    threshold?: number;
  },
  authorized: RetrievalPredicates = {},
) {
  const searchVector = await documentSearchVector(db);
  const limit = options?.limit ?? 10;
  const types = options?.types ?? ["document", "task", "requirement"];
  const threshold = options?.threshold ?? 0.01;

  // Fetch the source document
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      content: documents.content,
      projectId: documents.projectId,
      keywords: documents.keywords,
      summary: documents.summary,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) throw new NotFoundError("Document not found");

  const projectId = options?.projectId ?? doc.projectId ?? undefined;

  // Build search text from title + keywords + summary
  const searchText = [
    doc.title,
    ...(doc.keywords ?? []),
    doc.summary ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const tsQuery = buildTsQuery(searchText);
  const results: RecommendationItem[] = [];

  // Get existing links to exclude
  const [linkedDocIds, linkedTaskIds, linkedReqIds] = await Promise.all([
    types.includes("document") ? getLinkedDocIds(db, documentId) : Promise.resolve([]),
    types.includes("task") ? getLinkedTaskIds(db, documentId) : Promise.resolve([]),
    types.includes("requirement") ? getLinkedReqIds(db, documentId) : Promise.resolve([]),
  ]);

  // 1. Similar documents via tsvector
  if (types.includes("document") && tsQuery) {
    const excludeIds = [documentId, ...linkedDocIds];

    const projectCond = projectId
      ? or(eq(documents.projectId, projectId), isNull(documents.projectId))
      : undefined;

    const conditions = [
      authorized.documents,
      sql`${searchVector} @@ to_tsquery('english', ${tsQuery})`,
      notInArray(documents.id, excludeIds),
    ];
    if (projectCond) conditions.push(projectCond);

    const similarDocs = await db
      .select({
        id: documents.id,
        title: documents.title,
        rank: sql<number>`ts_rank(${searchVector}, to_tsquery('english', ${tsQuery}))`.as(
          "rank",
        ),
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(sql`rank DESC`)
      .limit(limit);

    for (const d of similarDocs) {
      if (d.rank >= threshold) {
        results.push({
          id: d.id,
          type: "document",
          title: d.title,
          score: Math.round(d.rank * 1000) / 1000,
          reason: "Similar content based on text analysis",
        });
      }
    }
  }

  // 2. Similar tasks via ILIKE keyword matching
  if (types.includes("task")) {
    const keywords = [
      ...(doc.keywords ?? []),
      ...doc.title.split(/\s+/).filter((w) => w.length > 2),
    ].slice(0, 10);

    if (keywords.length > 0) {
      const taskConditions = [authorized.tasks];

      // Match tasks whose title or description contains any keyword
      const keywordPatterns = keywords.map(
        (kw) =>
          or(
            sql`${tasks.title} ILIKE ${"%" + kw + "%"}`,
            sql`${tasks.description} ILIKE ${"%" + kw + "%"}`,
          ),
      );
      taskConditions.push(or(...keywordPatterns));

      if (projectId) {
        taskConditions.push(eq(tasks.projectId, projectId));
      }

      // Exclude already linked tasks
      if (linkedTaskIds.length > 0) {
        taskConditions.push(notInArray(tasks.id, linkedTaskIds));
      }

      // Exclude cancelled tasks
      taskConditions.push(ne(tasks.status, "cancelled"));

      const matchingTasks = await db
        .select({
          id: tasks.id,
          title: tasks.title,
        })
        .from(tasks)
        .where(and(...taskConditions))
        .limit(limit);

      // Score tasks by how many keywords match
      for (const t of matchingTasks) {
        const titleLower = t.title.toLowerCase();
        const matchCount = keywords.filter((kw) =>
          titleLower.includes(kw.toLowerCase()),
        ).length;
        const score = matchCount / keywords.length;

        if (score >= threshold) {
          results.push({
            id: t.id,
            type: "task",
            title: t.title,
            score: Math.round(score * 1000) / 1000,
            reason: `Matches ${matchCount} keyword(s) from document`,
          });
        }
      }
    }
  }

  // 3. Similar requirements via ILIKE keyword matching
  if (types.includes("requirement")) {
    const keywords = [
      ...(doc.keywords ?? []),
      ...doc.title.split(/\s+/).filter((w) => w.length > 2),
    ].slice(0, 10);

    if (keywords.length > 0) {
      const reqConditions = [authorized.requirements];

      const keywordPatterns = keywords.map(
        (kw) =>
          or(
            sql`${requirements.title} ILIKE ${"%" + kw + "%"}`,
            sql`${requirements.description} ILIKE ${"%" + kw + "%"}`,
          ),
      );
      reqConditions.push(or(...keywordPatterns));

      if (projectId) {
        reqConditions.push(eq(requirements.projectId, projectId));
      }

      if (linkedReqIds.length > 0) {
        reqConditions.push(notInArray(requirements.id, linkedReqIds));
      }

      reqConditions.push(ne(requirements.status, "cancelled"));

      const matchingReqs = await db
        .select({
          id: requirements.id,
          title: requirements.title,
        })
        .from(requirements)
        .where(and(...reqConditions))
        .limit(limit);

      for (const r of matchingReqs) {
        const titleLower = r.title.toLowerCase();
        const matchCount = keywords.filter((kw) =>
          titleLower.includes(kw.toLowerCase()),
        ).length;
        const score = matchCount / keywords.length;

        if (score >= threshold) {
          results.push({
            id: r.id,
            type: "requirement",
            title: r.title,
            score: Math.round(score * 1000) / 1000,
            reason: `Matches ${matchCount} keyword(s) from document`,
          });
        }
      }
    }
  }

  // Sort all results by score descending and limit
  results.sort((a, b) => b.score - a.score);

  const output: RecommendationsResult = {
    entityId: documentId,
    entityType: "document",
    recommendations: results.slice(0, limit),
  };

  return output;
}

/**
 * Get recommendations for a task.
 * Finds similar documents, tasks, and requirements using text matching.
 */
export async function getTaskRecommendations(
  db: Database,
  taskId: string,
  options?: {
    limit?: number;
    types?: ("document" | "task" | "requirement")[];
    threshold?: number;
  },
  authorized: RetrievalPredicates = {},
) {
  const searchVector = await documentSearchVector(db);
  const limit = options?.limit ?? 10;
  const types = options?.types ?? ["document", "task", "requirement"];
  const threshold = options?.threshold ?? 0.01;

  // Fetch the source task
  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      projectId: tasks.projectId,
      tags: tasks.tags,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) throw new NotFoundError("Task not found");

  const projectId = task.projectId;
  if (!projectId) {
    return {
      entityId: taskId,
      entityType: "task",
      recommendations: [],
    };
  }

  // Build search text from title + description + tags
  const searchText = [
    task.title,
    task.description ?? "",
    ...(task.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  const tsQuery = buildTsQuery(searchText);
  const keywords = [
    ...task.title.split(/\s+/).filter((w) => w.length > 2),
    ...(task.tags ?? []),
  ].slice(0, 10);

  const results: RecommendationItem[] = [];

  // Get existing task-document links to exclude
  const existingDocLinks = await db
    .select({ id: documentTaskLinks.documentId })
    .from(documentTaskLinks)
    .where(eq(documentTaskLinks.taskId, taskId));
  const linkedDocIds = existingDocLinks.map((r) => r.id);

  // Get existing task dependencies to exclude
  const existingDeps = await db
    .select({ id: sql<string>`depends_on_task_id`.as("id") })
    .from(sql`task_dependencies`)
    .where(sql`task_id = ${taskId} OR depends_on_task_id = ${taskId}`);
  const linkedTaskIds = [taskId, ...existingDeps.map((r) => r.id)];

  // 1. Similar documents via tsvector
  if (types.includes("document") && tsQuery) {
    const conditions = [
      authorized.documents,
      sql`${searchVector} @@ to_tsquery('english', ${tsQuery})`,
    ];

    if (linkedDocIds.length > 0) {
      conditions.push(notInArray(documents.id, linkedDocIds));
    }

    conditions.push(
      or(
        eq(documents.projectId, projectId),
        and(isNull(documents.projectId), isNull(documents.personalOwnerId))!,
      )!,
    );

    const similarDocs = await db
      .select({
        id: documents.id,
        title: documents.title,
        rank: sql<number>`ts_rank(${searchVector}, to_tsquery('english', ${tsQuery}))`.as(
          "rank",
        ),
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(sql`rank DESC`)
      .limit(limit);

    for (const d of similarDocs) {
      if (d.rank >= threshold) {
        results.push({
          id: d.id,
          type: "document",
          title: d.title,
          score: Math.round(d.rank * 1000) / 1000,
          reason: "Similar content based on text analysis",
        });
      }
    }
  }

  // 2. Similar tasks via keyword matching (same project)
  if (types.includes("task") && keywords.length > 0) {
    const taskConditions = [authorized.tasks];

    const keywordPatterns = keywords.map(
      (kw) =>
        or(
          sql`${tasks.title} ILIKE ${"%" + kw + "%"}`,
          sql`${tasks.description} ILIKE ${"%" + kw + "%"}`,
        ),
    );
    taskConditions.push(or(...keywordPatterns));
    taskConditions.push(eq(tasks.projectId, projectId));
    taskConditions.push(notInArray(tasks.id, linkedTaskIds));
    taskConditions.push(ne(tasks.status, "cancelled"));

    const matchingTasks = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(...taskConditions))
      .limit(limit);

    for (const t of matchingTasks) {
      const titleLower = t.title.toLowerCase();
      const matchCount = keywords.filter((kw) =>
        titleLower.includes(kw.toLowerCase()),
      ).length;
      const score = matchCount / keywords.length;

      if (score >= threshold) {
        results.push({
          id: t.id,
          type: "task",
          title: t.title,
          score: Math.round(score * 1000) / 1000,
          reason: `Matches ${matchCount} keyword(s) from task`,
        });
      }
    }
  }

  // 3. Similar requirements via keyword matching (same project)
  if (types.includes("requirement") && keywords.length > 0) {
    const reqConditions = [authorized.requirements];

    const keywordPatterns = keywords.map(
      (kw) =>
        or(
          sql`${requirements.title} ILIKE ${"%" + kw + "%"}`,
          sql`${requirements.description} ILIKE ${"%" + kw + "%"}`,
        ),
    );
    reqConditions.push(or(...keywordPatterns));
    reqConditions.push(eq(requirements.projectId, projectId));
    reqConditions.push(ne(requirements.status, "cancelled"));

    const matchingReqs = await db
      .select({ id: requirements.id, title: requirements.title })
      .from(requirements)
      .where(and(...reqConditions))
      .limit(limit);

    for (const r of matchingReqs) {
      const titleLower = r.title.toLowerCase();
      const matchCount = keywords.filter((kw) =>
        titleLower.includes(kw.toLowerCase()),
      ).length;
      const score = matchCount / keywords.length;

      if (score >= threshold) {
        results.push({
          id: r.id,
          type: "requirement",
          title: r.title,
          score: Math.round(score * 1000) / 1000,
          reason: `Matches ${matchCount} keyword(s) from task`,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  return {
    entityId: taskId,
    entityType: "task",
    recommendations: results.slice(0, limit),
  } satisfies RecommendationsResult;
}
