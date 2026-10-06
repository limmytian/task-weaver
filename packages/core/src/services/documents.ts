import { documentSearchVector } from "./search-vector";
import type { SQL } from "drizzle-orm";
import { and, eq, or, isNull, sql, inArray, desc } from "drizzle-orm";
import {
  type Database,
  documents,
  documentLinks,
  documentTaskLinks,
  documentVersions,
  activityLog,
  documentEmbeddings,
  documentEmbeddingStates,
  embeddingDocumentChunks,
  embeddingGenerations,
  embeddingProfiles,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  CreateDocumentInput,
  UpdateDocumentInput,
  ListDocumentsInput,
  SearchDocumentsInput,
  ListDocumentVersionsInput,
  CompareDocumentVersionsInput,
  RevertDocumentInput,
} from "@task-weaver/contracts";
import { emit } from "@task-weaver/realtime";
import { NotFoundError } from "@task-weaver/contracts";
import {
  profileDocumentsCondition,
  reconcileDeletedDocumentEmbedding,
  reconcileDocumentEmbeddingCoverage,
} from "./embeddings";
import {
  EmbeddingProviderError,
  createOpenAICompatibleEmbeddingProvider,
  resolveEmbeddingSecretReference,
} from "./embeddings";

// -- Markdown normalization --

export function normalizeMarkdown(content: string): string {
  let result = content;
  // Ensure space after heading markers
  result = result.replace(/^(#{1,6})([^\s#])/gm, "$1 $2");
  // Ensure space after list markers
  result = result.replace(/^([-*+])([^\s])/gm, "$1 $2");
  // Collapse 3+ consecutive blank lines into 2
  result = result.replace(/\n{3,}/g, "\n\n");
  // Lowercase code block language identifiers
  result = result.replace(/```([A-Z]+)/g, (_, lang) => "```" + lang.toLowerCase());
  return result.trim();
}

// -- Reading time estimation --

function estimateReadingTimeMin(content: string): number {
  // ~200 words/min for English, ~400 chars/min for CJK
  const cjkChars = (content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const words = content.replace(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, "").split(/\s+/).filter(Boolean).length;
  const minutes = words / 200 + cjkChars / 400;
  return Math.max(1, Math.ceil(minutes));
}

// -- Wiki-link parser --

const WIKI_LINK_WITH_CONTEXT = /(.{0,80})\[\[([^\]|]+)(?:\|([^\]]+))?\]\](.{0,80})/g;

interface ParsedLink {
  targetTitle: string;
  displayText?: string;
  context?: string;
}

export function parseWikiLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  let match: RegExpExecArray | null;
  WIKI_LINK_WITH_CONTEXT.lastIndex = 0;
  while ((match = WIKI_LINK_WITH_CONTEXT.exec(content)) !== null) {
    const before = match[1]!.replace(/\n/g, " ").trim();
    const after = match[4]!.replace(/\n/g, " ").trim();
    links.push({
      targetTitle: match[2]!.trim(),
      displayText: match[3]?.trim(),
      context: `...${before}[[${match[2]!.trim()}]]${after}...`,
    });
  }
  return links;
}

// -- Document type inference --

import type { DocType } from "@task-weaver/contracts";

const DOC_TYPE_RULES: { type: DocType; titlePatterns: RegExp[]; contentPatterns: RegExp[]; weight: number }[] = [
  {
    type: "requirement",
    titlePatterns: [/\b(requirement|需求|user stor|feature request|acceptance criteria|spec)\b/i],
    contentPatterns: [
      /\b(as a user|given .+ when .+ then|acceptance criteria|functional requirement|non-functional requirement|use case|用例|需求描述|验收标准)\b/i,
    ],
    weight: 1,
  },
  {
    type: "design",
    titlePatterns: [/\b(design|architecture|设计|架构|technical design|system design|schema|erd|data model)\b/i],
    contentPatterns: [
      /\b(component diagram|sequence diagram|class diagram|flowchart|architecture|tech stack|database schema|api design|系统设计|技术方案)\b/i,
      /```(mermaid|plantuml|dot)/i,
    ],
    weight: 1,
  },
  {
    type: "meeting",
    titlePatterns: [/\b(meeting|会议|standup|retro|retrospective|sync|minutes|议题|周会|日会)\b/i],
    contentPatterns: [
      /\b(attendees|agenda|action items|decisions|participants|参会人|议程|会议纪要|待办事项)\b/i,
    ],
    weight: 1,
  },
  {
    type: "guide",
    titlePatterns: [/\b(guide|tutorial|how[ -]to|getting started|指南|教程|入门|quickstart|onboarding|setup)\b/i],
    contentPatterns: [
      /\b(step \d|prerequisites|installation|configure|usage example|步骤|前置条件|安装|配置说明)\b/i,
    ],
    weight: 1,
  },
  {
    type: "reference",
    titlePatterns: [/\b(reference|api ref|glossary|changelog|faq|参考|术语|更新日志|常见问题)\b/i],
    contentPatterns: [
      /\b(endpoint|parameter|return value|status code|接口|参数|返回值|错误码)\b/i,
    ],
    weight: 1,
  },
];

export function inferDocType(title: string, content: string): DocType {
  const scores: Record<string, number> = {};

  for (const rule of DOC_TYPE_RULES) {
    let score = 0;
    for (const pattern of rule.titlePatterns) {
      if (pattern.test(title)) score += 2 * rule.weight; // title matches weigh more
    }
    for (const pattern of rule.contentPatterns) {
      if (pattern.test(content)) score += 1 * rule.weight;
    }
    if (score > 0) {
      scores[rule.type] = score;
    }
  }

  // Return the highest-scoring type, or "other" if no matches
  let best: DocType = "other";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = type as DocType;
    }
  }
  return best;
}

// -- CRUD --

async function runEmbeddingReconciliationBestEffort(
  documentId: string,
  operation: "upsert" | "delete",
  reconcile: () => Promise<unknown>,
) {
  try {
    await reconcile();
  } catch (error) {
    // Embedding is optional and catch-up jobs can reconstruct coverage later. A sidecar
    // reconciliation failure must never turn a committed document write into an API error.
    console.error("Embedding reconciliation failed after document write", {
      documentId,
      operation,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function createDocument(
  db: Database,
  input: CreateDocumentInput,
  actor: Actor,
  authorizedPredicate?: SQL,
) {
  const normalizedContent = normalizeMarkdown(input.content);
  const docType = input.docType ?? inferDocType(input.title, normalizedContent);

  const [doc] = await db
    .insert(documents)
    .values({
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
      title: input.title,
      content: normalizedContent,
      tags: input.tags,
      summary: input.summary,
      keywords: input.keywords,
      docType,
      language: input.language ?? "en",
      readingTimeMin: estimateReadingTimeMin(normalizedContent),
      generatedBy: input.generatedBy,
      generationPrompt: input.generationPrompt,
      confidence: input.confidence,
      needsReview: input.needsReview ?? false,
      createdBy: actor.id,
    })
    .returning();

  // Snapshot initial version
  await db.insert(documentVersions).values({
    documentId: doc!.id,
    version: 1,
    title: doc!.title,
    content: doc!.content,
    summary: doc!.summary,
    keywords: doc!.keywords,
    docType: doc!.docType,
    changeType: "created",
    changedBy: actor.id,
    changedByType: actor.type,
  });

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: doc!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
  });

  // Sync wiki-links (with context extraction)
  await syncDocumentLinks(db, doc!.id, normalizedContent, authorizedPredicate);

  // Embedding is opt-in. This only records coverage and queues durable work for enabled profiles;
  // it never calls a provider from the document write path.
  await runEmbeddingReconciliationBestEffort(doc!.id, "upsert", () => (
    reconcileDocumentEmbeddingCoverage(db, doc!, actor)
  ));

  emit({ type: "document_created", projectId: doc!.projectId, documentId: doc!.id, title: doc!.title });

  return doc!;
}

export async function getDocument(db: Database, id: string) {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, id),
  });
  if (!doc) throw new NotFoundError("Document not found");
  return doc;
}

export async function getDocumentDetail(db: Database, id: string) {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, id),
    with: {
      outgoingLinks: { with: { targetDoc: true } },
      incomingLinks: { with: { sourceDoc: true } },
      taskLinks: { with: { task: true } },
      requirementLinks: { with: { requirement: true } },
    },
  });
  if (!doc) throw new NotFoundError("Document not found");
  return doc;
}

type PagedDocumentList = {
  items: unknown[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  view: "summary" | "full"
}

export function listDocuments(
  db: Database,
  input: ListDocumentsInput & { view: "summary" | "full" },
  authorizedPredicate?: SQL,
): Promise<PagedDocumentList>

export function listDocuments(
  db: Database,
  input: ListDocumentsInput,
  authorizedPredicate?: SQL,
): Promise<Array<typeof documents.$inferSelect>>

export async function listDocuments(
  db: Database,
  input: ListDocumentsInput,
  authorizedPredicate?: SQL,
): Promise<PagedDocumentList | Array<typeof documents.$inferSelect>> {
  const conditions = [authorizedPredicate];

  conditions.push(buildDocumentScopeCondition(input), authorizedPredicate);

  if (input.docType) {
    conditions.push(eq(documents.docType, input.docType));
  }
  if (input.tag) {
    conditions.push(sql`${input.tag} = ANY(${documents.tags})`);
  }
  if (input.query) {
    const pattern = `%${input.query}%`;
    conditions.push(sql`(
      ${documents.title} ILIKE ${pattern}
      OR COALESCE(${documents.summary}, '') ILIKE ${pattern}
    )`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  if (input.view === undefined) {
    return db.query.documents.findMany({
      where,
      orderBy: (d, { desc }) => [desc(d.updatedAt)],
    });
  }

  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? (input.view === "full" ? 5 : 20);
  const offset = (page - 1) * pageSize;
  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(where);

  if (input.view === "summary") {
    const [items, totalRows] = await Promise.all([
      db.query.documents.findMany({
        where,
        columns: {
          id: true,
          projectId: true,
          title: true,
          summary: true,
          tags: true,
          keywords: true,
          docType: true,
          language: true,
          readingTimeMin: true,
          version: true,
          generatedBy: true,
          confidence: true,
          needsReview: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: (d, { desc }) => [desc(d.updatedAt)],
        limit: pageSize,
        offset,
      }),
      totalQuery,
    ]);
    const total = totalRows[0]?.count ?? 0;
    return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize), view: "summary" };
  }

  const [items, totalRows] = await Promise.all([
    db.query.documents.findMany({
      where,
      orderBy: (d, { desc }) => [desc(d.updatedAt)],
      limit: pageSize,
      offset,
    }),
    totalQuery,
  ]);
  const total = totalRows[0]?.count ?? 0;
  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize), view: "full" };
}


export async function updateDocument(
  db: Database,
  id: string,
  input: UpdateDocumentInput,
  actor: Actor,
  authorizedPredicate?: SQL,
) {
  const current = await getDocument(db, id);

  const updates: Record<string, unknown> = { ...input, updatedAt: new Date() };

  // Normalize markdown and recompute reading time if content changed
  if (input.content) {
    const normalizedContent = normalizeMarkdown(input.content);
    updates.content = normalizedContent;
    updates.readingTimeMin = estimateReadingTimeMin(normalizedContent);
  }

  // Snapshot current state as a new version before applying updates
  await createVersionSnapshot(db, current, "updated", actor);

  const [updated] = await db
    .update(documents)
    .set(updates)
    .where(eq(documents.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
  });

  // Re-sync wiki-links if content changed
  if (input.content) {
    await syncDocumentLinks(db, id, updates.content as string, authorizedPredicate);
  }

  await runEmbeddingReconciliationBestEffort(id, "upsert", () => (
    reconcileDocumentEmbeddingCoverage(db, updated!, actor)
  ));
  if (
    current.projectId !== updated!.projectId
    || current.personalOwnerId !== updated!.personalOwnerId
    || current.personalOwnerType !== updated!.personalOwnerType
  ) {
    await runEmbeddingReconciliationBestEffort(id, "delete", () => (
      reconcileDeletedDocumentEmbedding(db, current, actor)
    ));
  }

  emit({ type: "document_updated", documentId: id });

  return updated!;
}

export async function deleteDocument(db: Database, id: string, actor: Actor) {
  const current = await getDocument(db, id);

  await runEmbeddingReconciliationBestEffort(id, "delete", () => (
    reconcileDeletedDocumentEmbedding(db, current, actor)
  ));

  await db.delete(documents).where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    action: "deleted",
    actorId: actor.id,
    actorType: actor.type,
  });

  emit({ type: "document_deleted", documentId: id });
}

// -- Links --

export async function linkDocuments(
  db: Database,
  sourceDocId: string,
  targetDocId: string,
  linkType: "reference" | "related" | "parent",
  actor: Actor,
  context?: string,
) {
  await getDocument(db, sourceDocId);
  await getDocument(db, targetDocId);

  const [link] = await db
    .insert(documentLinks)
    .values({ sourceDocId, targetDocId, linkType, context })
    .returning();

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: sourceDocId,
    action: "linked",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { targetDocId, linkType },
  });

  emit({ type: "document_linked", sourceDocId, targetDocId });

  return link!;
}

export async function linkDocumentToTask(
  db: Database,
  documentId: string,
  taskId: string,
  linkType: "references" | "documents" | "output",
  actor: Actor,
) {
  const [link] = await db
    .insert(documentTaskLinks)
    .values({ documentId, taskId, linkType })
    .returning();

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: documentId,
    action: "task_linked",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { taskId, linkType },
  });

  emit({ type: "document_task_linked", documentId, taskId });

  return link!;
}

export async function unlinkDocuments(db: Database, linkId: string, _expectedParentId?: string) {
  const [deleted] = await db
    .delete(documentLinks)
    .where(eq(documentLinks.id, linkId))
    .returning();
  if (!deleted) throw new NotFoundError("Document link not found");
  emit({ type: "document_unlinked", linkId });
  return deleted;
}

export async function unlinkDocumentFromTask(db: Database, linkId: string, _expectedParentId?: string) {
  const [deleted] = await db
    .delete(documentTaskLinks)
    .where(eq(documentTaskLinks.id, linkId))
    .returning();
  if (!deleted) throw new NotFoundError("Document-task link not found");
  emit({ type: "document_task_unlinked", linkId });
  return deleted;
}

export async function getDocumentByTitle(db: Database, title: string, authorizedPredicate?: SQL) {
  return db.query.documents.findFirst({
    where: and(eq(documents.title, title), authorizedPredicate),
    columns: { id: true, title: true },
  });
}

export async function resolveDocumentTitles(db: Database, titles: string[], authorizedPredicate?: SQL) {
  if (titles.length === 0) return [];
  return db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(inArray(documents.title, titles), authorizedPredicate));
}

export async function getBacklinks(db: Database, docId: string) {
  return db.query.documentLinks.findMany({
    where: eq(documentLinks.targetDocId, docId),
    with: { sourceDoc: true },
  });
}

// -- Wiki-link sync --

async function syncDocumentLinks(
  db: Database,
  docId: string,
  content: string,
  authorizedPredicate?: SQL,
) {
  const parsed = parseWikiLinks(content);
  if (parsed.length === 0) {
    // Remove all outgoing links from this doc
    await db
      .delete(documentLinks)
      .where(eq(documentLinks.sourceDocId, docId));
    return;
  }

  const targetTitles = parsed.map((l) => l.targetTitle);

  // Resolve titles to document IDs
  const targetDocs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(inArray(documents.title, targetTitles), authorizedPredicate));

  const titleToId = new Map(targetDocs.map((d) => [d.title, d.id]));
  // Build context map: targetDocId -> context string
  const targetIdToContext = new Map<string, string>();
  for (const link of parsed) {
    const docId_ = titleToId.get(link.targetTitle);
    if (docId_ && link.context) {
      targetIdToContext.set(docId_, link.context);
    }
  }

  const resolvedTargetIds = new Set(
    parsed.map((l) => titleToId.get(l.targetTitle)).filter(Boolean) as string[],
  );

  // Get existing outgoing links
  const existingLinks = await db
    .select()
    .from(documentLinks)
    .where(eq(documentLinks.sourceDocId, docId));
  const existingTargetIds = new Set(existingLinks.map((l) => l.targetDocId));

  // Add new links (with context)
  const toAdd = [...resolvedTargetIds].filter((id) => !existingTargetIds.has(id));
  if (toAdd.length > 0) {
    await db.insert(documentLinks).values(
      toAdd.map((targetDocId) => ({
        sourceDocId: docId,
        targetDocId,
        linkType: "reference" as const,
        context: targetIdToContext.get(targetDocId) ?? null,
      })),
    );
  }

  // Update context on existing reference links
  for (const existing of existingLinks) {
    if (existing.linkType === "reference" && resolvedTargetIds.has(existing.targetDocId)) {
      const newContext = targetIdToContext.get(existing.targetDocId);
      if (newContext && newContext !== existing.context) {
        await db
          .update(documentLinks)
          .set({ context: newContext })
          .where(eq(documentLinks.id, existing.id));
      }
    }
  }

  // Remove stale links (only auto-generated reference links)
  const toRemove = existingLinks
    .filter(
      (l) => l.linkType === "reference" && !resolvedTargetIds.has(l.targetDocId),
    )
    .map((l) => l.id);
  if (toRemove.length > 0) {
    await db
      .delete(documentLinks)
      .where(inArray(documentLinks.id, toRemove));
  }
}

// -- Version management --

async function createVersionSnapshot(
  db: Database,
  doc: { id: string; title: string; content: string; summary: string | null; keywords: string[] | null; docType: string },
  changeType: "created" | "updated" | "reverted",
  actor: Actor,
  changeDescription?: string,
): Promise<number> {
  const [latest] = await db
    .select({ maxVersion: sql<number>`coalesce(max(${documentVersions.version}), 0)` })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id));
  const nextVersion = (latest?.maxVersion ?? 0) + 1;

  await db.insert(documentVersions).values({
    documentId: doc.id,
    version: nextVersion,
    title: doc.title,
    content: doc.content,
    summary: doc.summary,
    keywords: doc.keywords,
    docType: doc.docType,
    changeType,
    changedBy: actor.id,
    changedByType: actor.type,
    changeDescription,
  });

  return nextVersion;
}

export async function listDocumentVersions(
  db: Database,
  input: ListDocumentVersionsInput,
) {
  await getDocument(db, input.documentId);

  return db
    .select({
      id: documentVersions.id,
      version: documentVersions.version,
      title: documentVersions.title,
      docType: documentVersions.docType,
      changeType: documentVersions.changeType,
      changedBy: documentVersions.changedBy,
      changedByType: documentVersions.changedByType,
      changeDescription: documentVersions.changeDescription,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, input.documentId))
    .orderBy(desc(documentVersions.version))
    .limit(input.limit)
    .offset(input.offset);
}

export async function getDocumentVersion(
  db: Database,
  documentId: string,
  version: number,
) {
  await getDocument(db, documentId);

  const [v] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.version, version),
      ),
    );
  if (!v) throw new NotFoundError(`Version ${version} not found`);
  return v;
}

export async function compareDocumentVersions(
  db: Database,
  input: CompareDocumentVersionsInput,
) {
  const [fromVersion, toVersion] = await Promise.all([
    getDocumentVersion(db, input.documentId, input.from),
    getDocumentVersion(db, input.documentId, input.to),
  ]);

  return {
    from: {
      version: fromVersion.version,
      title: fromVersion.title,
      content: fromVersion.content,
      docType: fromVersion.docType,
      changedBy: fromVersion.changedBy,
      createdAt: fromVersion.createdAt,
    },
    to: {
      version: toVersion.version,
      title: toVersion.title,
      content: toVersion.content,
      docType: toVersion.docType,
      changedBy: toVersion.changedBy,
      createdAt: toVersion.createdAt,
    },
    changes: {
      titleChanged: fromVersion.title !== toVersion.title,
      contentChanged: fromVersion.content !== toVersion.content,
      docTypeChanged: fromVersion.docType !== toVersion.docType,
    },
  };
}

export async function revertDocument(
  db: Database,
  documentId: string,
  input: RevertDocumentInput,
  actor: Actor,
  authorizedPredicate?: SQL,
) {
  const current = await getDocument(db, documentId);
  const targetVersion = await getDocumentVersion(db, documentId, input.version);

  // Snapshot current state before reverting
  await createVersionSnapshot(
    db,
    current,
    "reverted",
    actor,
    input.changeDescription ?? `Reverted to version ${input.version}`,
  );

  // Apply the target version's content to the document
  const normalizedContent = normalizeMarkdown(targetVersion.content);
  const [updated] = await db
    .update(documents)
    .set({
      title: targetVersion.title,
      content: normalizedContent,
      summary: targetVersion.summary,
      keywords: targetVersion.keywords,
      docType: targetVersion.docType as any,
      readingTimeMin: estimateReadingTimeMin(normalizedContent),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId))
    .returning();

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: documentId,
    action: "reverted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { toVersion: input.version },
  });

  await syncDocumentLinks(db, documentId, normalizedContent, authorizedPredicate);

  await reconcileDocumentEmbeddingCoverage(db, updated!, actor);

  emit({ type: "document_updated", documentId });

  return updated!;
}

// -- Search --

const SEARCH_RESULT_COLUMNS = {
  id: documents.id,
  title: documents.title,
  summary: documents.summary,
  keywords: documents.keywords,
  docType: documents.docType,
  projectId: documents.projectId,
  personalOwnerId: documents.personalOwnerId,
  personalOwnerType: documents.personalOwnerType,
  tags: documents.tags,
  updatedAt: documents.updatedAt,
};

function buildDocumentScopeCondition(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.projectId) {
    scopes.push(eq(documents.projectId, input.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(documents.projectId), isNull(documents.personalOwnerId))!);
    }
  } else {
    scopes.push(and(isNull(documents.projectId), isNull(documents.personalOwnerId))!);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(
      and(
        isNull(documents.projectId),
        eq(documents.personalOwnerId, input.personalOwnerId),
        eq(documents.personalOwnerType, input.personalOwnerType),
      )!,
    );
  }

  return or(...scopes)!;
}

function buildTsQuery(query: string): string | null {
  const tsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/'/g, ""))
    .join(" & ");
  return tsQuery || null;
}

function searchDocumentsKeyword(db: Database, input: SearchDocumentsInput, authorizedPredicate?: SQL) {
  const conditions = [];
  const likePattern = `%${input.query}%`;
  conditions.push(
    or(
      sql`${documents.title} ILIKE ${likePattern}`,
      sql`${documents.content} ILIKE ${likePattern}`,
    ),
  );

  conditions.push(buildDocumentScopeCondition(input), authorizedPredicate);

  return db
    .select(SEARCH_RESULT_COLUMNS)
    .from(documents)
    .where(and(...conditions))
    .limit(input.limit);
}

export interface SearchDocumentsMetadata {
  requestedMode: "keyword" | "fulltext" | "semantic" | "hybrid";
  effectiveMode: "keyword" | "fulltext" | "semantic" | "hybrid";
  fallbackReason?: string;
  profileId?: string;
  generationId?: string;
  coverage?: { totalDocuments: number; completeDocuments: number };
}

export interface SearchDocumentsWithMetadataResult<T = unknown> {
  items: T[];
  metadata: SearchDocumentsMetadata;
}

export interface SearchDocumentItem {
  id: string;
  title: string;
  summary: string | null;
  keywords: string[] | null;
  docType: string | null;
  projectId: string | null;
  personalOwnerId: string | null;
  personalOwnerType: "human" | "agent" | null;
  tags: string[] | null;
  updatedAt: Date;
  score?: number;
  rank?: number;
  scores?: { lexical?: number; semantic?: number };
}

function searchMetadata(
  input: SearchDocumentsInput,
  effectiveMode: SearchDocumentsMetadata["effectiveMode"],
  extra: Omit<SearchDocumentsMetadata, "requestedMode" | "effectiveMode"> = {},
): SearchDocumentsMetadata {
  return {
    requestedMode: input.mode ?? "keyword",
    effectiveMode,
    ...extra,
  };
}

async function findSemanticProfile(db: Database, input: SearchDocumentsInput, authorizedPredicate?: SQL, profilePredicate?: SQL) {
  const enabledProfiles = await db.query.embeddingProfiles.findMany({
    where: and(eq(embeddingProfiles.status, "enabled"), profilePredicate),
  });
  const candidates = enabledProfiles.filter((profile) => {
    if (input.projectId) {
      return (profile.scope === "project" && profile.projectId === input.projectId)
        || (profile.scope === "global" && input.includeGlobal);
    }
    if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
      return (profile.scope === "personal"
        && profile.personalOwnerId === input.personalOwnerId
        && profile.personalOwnerType === input.personalOwnerType)
        || (profile.scope === "global" && input.includeGlobal);
    }
    return profile.scope === "global" && input.includeGlobal;
  });
  candidates.sort((left, right) => {
    const rank = (profile: typeof embeddingProfiles.$inferSelect) => {
      if (input.projectId && profile.scope === "project") return 0;
      if (!input.projectId && profile.scope === "personal") return 0;
      return 1;
    };
    return rank(left) - rank(right);
  });
  const profile = candidates[0];
  if (!profile?.activeGenerationId) return null;
  const generation = await db.query.embeddingGenerations.findFirst({
    where: eq(embeddingGenerations.id, profile.activeGenerationId),
  });
  if (!generation || generation.profileId !== profile.id || generation.status !== "active" || generation.configurationHash !== profile.configurationHash) {
    return { profile, reason: "generation_unavailable" as const };
  }

  const scopedDocuments = await db.query.documents.findMany({
    where: and(profileDocumentsCondition(profile), buildDocumentScopeCondition(input), authorizedPredicate),
    columns: { id: true },
  });
  const completeStates = scopedDocuments.length === 0
    ? []
    : await db.query.documentEmbeddingStates.findMany({
      where: and(
        eq(documentEmbeddingStates.profileId, profile.id),
        eq(documentEmbeddingStates.generationId, generation.id),
        eq(documentEmbeddingStates.state, "complete"),
        inArray(documentEmbeddingStates.documentId, scopedDocuments.map((document) => document.id)),
      ),
      columns: { documentId: true },
    });
  if (completeStates.length < scopedDocuments.length) {
    return {
      profile,
      generation,
      reason: "incomplete_coverage" as const,
      coverage: { totalDocuments: scopedDocuments.length, completeDocuments: completeStates.length },
    };
  }
  return {
    profile,
    generation,
    coverage: { totalDocuments: scopedDocuments.length, completeDocuments: completeStates.length },
  };
}

async function searchDocumentsSemantic(
  db: Database,
  input: SearchDocumentsInput,
  profile: typeof embeddingProfiles.$inferSelect,
  generation: typeof embeddingGenerations.$inferSelect,
  authorizedPredicate?: SQL,
) {
  const provider = createOpenAICompatibleEmbeddingProvider({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    dimensions: profile.dimensions,
    secretRef: profile.secretRef,
    timeoutMs: profile.timeoutMs,
    batchSize: profile.batchSize,
  }, { resolveSecret: resolveEmbeddingSecretReference });
  const queryResult = await provider.embed({
    operationId: `search-${generation.id}`,
    inputs: [{ id: "query", text: input.query }],
  });
  const queryVector = queryResult.vectors[0]?.embedding;
  if (!queryVector) throw new EmbeddingProviderError("Query embedding was empty", { code: "invalid_response" });
  if (!Number.isInteger(generation.dimensions) || generation.dimensions < 1 || generation.dimensions > 2000) {
    throw new EmbeddingProviderError("Embedding generation dimensions are invalid", { code: "invalid_response" });
  }
  const vectorLiteral = `[${queryVector.join(",")}]`;
  const generationVectorType = sql.raw(`vector(${generation.dimensions})`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation.id)) {
    throw new EmbeddingProviderError("Embedding generation id is invalid", { code: "invalid_response" });
  }
  // Inline the UUID only after strict validation. PostgreSQL cannot prove a partial
  // index predicate for a generic prepared parameter, so a bound generation id would
  // silently fall back to the btree generation index after the plan cache switches.
  const generationIdLiteral = sql.raw(`'${generation.id}'::uuid`);
  const semanticDistance = sql<number>`(${documentEmbeddings.embedding}::${generationVectorType}) <=> ${vectorLiteral}::${generationVectorType}`;
  const semanticCandidates = db
    .select({
      chunkId: documentEmbeddings.chunkId,
      semanticDistance: semanticDistance.as("semantic_distance"),
    })
    .from(documentEmbeddings)
    .innerJoin(embeddingDocumentChunks, eq(embeddingDocumentChunks.id, documentEmbeddings.chunkId))
    .innerJoin(documents, eq(documents.id, embeddingDocumentChunks.documentId))
    .innerJoin(documentEmbeddingStates, and(
      eq(documentEmbeddingStates.documentId, documents.id),
      eq(documentEmbeddingStates.profileId, profile.id),
      eq(documentEmbeddingStates.generationId, generation.id),
      eq(documentEmbeddingStates.state, "complete"),
    ))
    .where(and(sql`${documentEmbeddings.generationId} = ${generationIdLiteral}`,
      eq(embeddingDocumentChunks.generationId, generation.id),
      profileDocumentsCondition(profile), buildDocumentScopeCondition(input), authorizedPredicate))
    // pgvector only uses an ANN index when the distance operator is the top-level
    // ascending ORDER BY expression in the limited candidate query.
    .orderBy(semanticDistance)
    .limit(Math.min(200, input.limit * 8))
    .as("semantic_candidates");
  const rows = await db
    .select({
      ...SEARCH_RESULT_COLUMNS,
      semanticDistance: semanticCandidates.semanticDistance,
    })
    .from(semanticCandidates)
    .innerJoin(embeddingDocumentChunks, eq(embeddingDocumentChunks.id, semanticCandidates.chunkId))
    .innerJoin(documents, eq(documents.id, embeddingDocumentChunks.documentId))
    .innerJoin(documentEmbeddingStates, and(
      eq(documentEmbeddingStates.profileId, profile.id),
      eq(documentEmbeddingStates.documentId, documents.id),
      eq(documentEmbeddingStates.generationId, generation.id),
      eq(documentEmbeddingStates.state, "complete"),
    ))
    .where(and(
      eq(embeddingDocumentChunks.generationId, generation.id),
      profileDocumentsCondition(profile),
    ))
    .orderBy(semanticCandidates.semanticDistance)
    .limit(input.limit * 8);

  const bestByDocument = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const previous = bestByDocument.get(row.id);
    if (!previous || Number(row.semanticDistance) < Number(previous.semanticDistance)) {
      bestByDocument.set(row.id, row);
    }
  }
  return [...bestByDocument.values()]
    .sort((left, right) => Number(left.semanticDistance) - Number(right.semanticDistance))
    .slice(0, input.limit)
    .map((row) => {
      const { semanticDistance: distance, ...document } = row;
      const semanticScore = Math.max(0, 1 - Number(distance));
      return {
        ...document,
        score: semanticScore,
        scores: { semantic: semanticScore },
      };
    });
}

async function lexicalFallback(db: Database, input: SearchDocumentsInput, authorizedPredicate?: SQL) {
  try {
    return {
      items: await db.transaction(tx => searchDocumentsFullText(tx as unknown as Database, input, authorizedPredicate)),
      mode: "fulltext" as const,
    };
  } catch {
    return {
      items: await searchDocumentsKeyword(db, input, authorizedPredicate),
      mode: "keyword" as const,
    };
  }
}

export async function searchDocumentsWithMetadata(
  db: Database,
  input: SearchDocumentsInput,
  authorizedPredicate?: SQL,
  profilePredicate?: SQL,
): Promise<SearchDocumentsWithMetadataResult> {
  const mode = input.mode ?? "keyword";
  if (mode === "keyword") {
    return {
      items: await searchDocumentsKeyword(db, input, authorizedPredicate),
      metadata: searchMetadata(input, "keyword"),
    };
  }
  if (mode === "fulltext") {
    const lexical = await lexicalFallback(db, input, authorizedPredicate);
    return {
      items: lexical.items,
      metadata: searchMetadata(input, lexical.mode, lexical.mode === "keyword" ? { fallbackReason: "fulltext_unavailable" } : {}),
    };
  }

  const resolved = await findSemanticProfile(db, input, authorizedPredicate, profilePredicate);
  if (!resolved || !resolved.generation) {
    const lexical = await lexicalFallback(db, input, authorizedPredicate);
    return {
      items: lexical.items,
      metadata: searchMetadata(input, lexical.mode, {
        fallbackReason: resolved?.reason ?? "embedding_disabled",
        profileId: resolved?.profile.id,
        generationId: undefined,
        coverage: resolved?.coverage,
      }),
    };
  }

  try {
    const semanticItems = await db.transaction(tx => searchDocumentsSemantic(tx as unknown as Database, input, resolved.profile, resolved.generation, authorizedPredicate));
    if (mode === "semantic") {
      return {
        items: semanticItems,
        metadata: searchMetadata(input, "semantic", {
          profileId: resolved.profile.id,
          generationId: resolved.generation.id,
          coverage: resolved.coverage,
        }),
      };
    }

    const lexical = await lexicalFallback(db, input, authorizedPredicate);
    const lexicalScores = new Map<string, number>();
    const maxLexical = Math.max(...lexical.items.map((row) => Number((row as { score?: number; rank?: number }).score ?? (row as { rank?: number }).rank ?? 0)), 0);
    for (const row of lexical.items) {
      const score = Number((row as { score?: number; rank?: number }).score ?? (row as { rank?: number }).rank ?? 0);
      lexicalScores.set((row as { id: string }).id, maxLexical > 0 ? score / maxLexical : 0);
    }
    const semanticById = new Map<string, { score?: number }>();
    for (const row of semanticItems) semanticById.set(String(row.id), row);
    const combined = new Map<string, Record<string, unknown>>();
    for (const row of lexical.items) combined.set(String(row.id), { ...row });
    for (const row of semanticItems) {
      const id = String(row.id);
      combined.set(id, { ...(combined.get(id) ?? row), ...row });
    }
    const semanticWeight = input.fulltextWeight ?? 0.7;
    const lexicalWeight = 1 - semanticWeight;
    const items = [...combined.values()].map((row) => {
      const id = String(row.id);
      const semanticScore = Number(semanticById.get(id)?.score ?? 0);
      const lexicalScore = lexicalScores.get(id) ?? 0;
      return {
        ...row,
        score: lexicalWeight * lexicalScore + semanticWeight * semanticScore,
        scores: { lexical: lexicalScore, semantic: semanticScore },
      };
    }).sort((left, right) => Number(right.score) - Number(left.score)).slice(0, input.limit);
    return {
      items,
      metadata: searchMetadata(input, "hybrid", {
        profileId: resolved.profile.id,
        generationId: resolved.generation.id,
        coverage: resolved.coverage,
      }),
    };
  } catch (error) {
    const lexical = await lexicalFallback(db, input, authorizedPredicate);
    return {
      items: lexical.items,
      metadata: searchMetadata(input, lexical.mode, {
        fallbackReason: error instanceof EmbeddingProviderError ? `provider_${error.code}` : "semantic_search_failed",
        profileId: resolved.profile.id,
        generationId: resolved.generation.id,
        coverage: resolved.coverage,
      }),
    };
  }
}

/**
 * Unified document search. The legacy array return shape is preserved for callers that do not
 * need effective-mode metadata; use searchDocumentsWithMetadata for operator-facing surfaces.
 */
export async function searchDocuments(
  db: Database,
  input: SearchDocumentsInput,
  authorizedPredicate?: SQL,
  profilePredicate?: SQL,
): Promise<SearchDocumentItem[]> {
  return (await searchDocumentsWithMetadata(db, input, authorizedPredicate, profilePredicate)).items as SearchDocumentItem[];
}

/**
 * Full-text search using tsvector. Requires running `pnpm --filter @task-weaver/db db:setup-search` first.
 * Uses weighted ranking: title matches rank higher than content matches.
 */
export async function searchDocumentsFullText(
  db: Database,
  input: SearchDocumentsInput,
  authorizedPredicate?: SQL,
) {
  const searchVector = await documentSearchVector(db);
  const tsQuery = buildTsQuery(input.query);
  if (!tsQuery) {
    return searchDocumentsKeyword(db, input, authorizedPredicate);
  }

  const conditions = [];
  conditions.push(sql`${searchVector} @@ to_tsquery('english', ${tsQuery})`);

  conditions.push(buildDocumentScopeCondition(input), authorizedPredicate);

  return db
    .select({
      ...SEARCH_RESULT_COLUMNS,
      rank: sql<number>`ts_rank(${searchVector}, to_tsquery('english', ${tsQuery}))`.as("rank"),
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(sql`rank DESC`)
    .limit(input.limit);
}
