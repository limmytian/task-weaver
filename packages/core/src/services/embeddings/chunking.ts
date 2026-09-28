import { createHash, randomUUID } from "node:crypto";

export interface EmbeddingDocumentSource {
  id: string;
  title: string;
  content: string;
  projectId?: string | null;
  personalOwnerId?: string | null;
  personalOwnerType?: "human" | "agent" | null;
  version: number;
}

export interface EmbeddingScopeSnapshot {
  scope: "global" | "project" | "personal";
  projectId: string | null;
  personalOwnerId: string | null;
  personalOwnerType: "human" | "agent" | null;
}

export interface EmbeddingChunkPlan {
  id: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  characterStart: number;
  characterEnd: number;
  tokenCount: number;
}

export interface DocumentEmbeddingPlan {
  documentId: string;
  documentVersion: number;
  documentHash: string;
  sourceText: string;
  scope: EmbeddingScopeSnapshot;
  chunks: EmbeddingChunkPlan[];
}

export interface ChunkingOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export function normalizeEmbeddingText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

export function hashEmbeddingText(value: string) {
  return createHash("sha256").update(normalizeEmbeddingText(value), "utf8").digest("hex");
}

export function buildDocumentEmbeddingText(document: Pick<EmbeddingDocumentSource, "title" | "content">) {
  return `${normalizeEmbeddingText(document.title)}\n\n${normalizeEmbeddingText(document.content)}`.trim();
}

export function hashDocumentEmbeddingContent(
  document: Pick<EmbeddingDocumentSource, "title" | "content">,
) {
  return hashEmbeddingText(buildDocumentEmbeddingText(document));
}

export function resolveEmbeddingScope(document: Pick<
  EmbeddingDocumentSource,
  "projectId" | "personalOwnerId" | "personalOwnerType"
>): EmbeddingScopeSnapshot {
  const projectId = document.projectId ?? null;
  const personalOwnerId = document.personalOwnerId ?? null;
  const personalOwnerType = document.personalOwnerType ?? null;
  if (projectId && (personalOwnerId || personalOwnerType)) {
    throw new Error("Embedding document scope cannot mix project and personal ownership");
  }
  if (!projectId && Boolean(personalOwnerId) !== Boolean(personalOwnerType)) {
    throw new Error("Embedding personal scope requires both owner id and owner type");
  }
  if (projectId) return { scope: "project", projectId, personalOwnerId: null, personalOwnerType: null };
  if (personalOwnerId && personalOwnerType) {
    return { scope: "personal", projectId: null, personalOwnerId, personalOwnerType };
  }
  return { scope: "global", projectId: null, personalOwnerId: null, personalOwnerType: null };
}

function estimateTokenCount(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function chunkEmbeddingText(text: string, options: ChunkingOptions): EmbeddingChunkPlan[] {
  const normalized = normalizeEmbeddingText(text);
  if (!normalized) return [];
  if (options.chunkSize < 100 || options.chunkOverlap < 0 || options.chunkOverlap >= options.chunkSize) {
    throw new Error("Invalid embedding chunking options");
  }

  const chunks: EmbeddingChunkPlan[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + options.chunkSize);
    if (end < normalized.length) {
      const preferredBoundary = normalized.lastIndexOf(" ", end);
      const minimumBoundary = start + Math.floor(options.chunkSize * 0.5);
      if (preferredBoundary > minimumBoundary) end = preferredBoundary;
    }
    if (end <= start) end = Math.min(normalized.length, start + options.chunkSize);
    const content = normalized.slice(start, end).trim();
    const leadingWhitespace = normalized.slice(start, end).search(/\S/);
    const contentStart = leadingWhitespace < 0 ? start : start + leadingWhitespace;
    const contentEnd = contentStart + content.length;
    if (content.length > 0) {
      chunks.push({
        id: randomUUID(),
        chunkIndex: chunks.length,
        content,
        contentHash: hashEmbeddingText(content),
        characterStart: contentStart,
        characterEnd: contentEnd,
        tokenCount: estimateTokenCount(content),
      });
    }
    if (end >= normalized.length) break;
    const nextStart = Math.max(start + 1, end - options.chunkOverlap);
    start = nextStart;
  }
  return chunks;
}

export function planDocumentEmbedding(
  document: EmbeddingDocumentSource,
  options: ChunkingOptions,
): DocumentEmbeddingPlan {
  const sourceText = buildDocumentEmbeddingText(document);
  return {
    documentId: document.id,
    documentVersion: document.version,
    documentHash: hashDocumentEmbeddingContent(document),
    sourceText,
    scope: resolveEmbeddingScope(document),
    chunks: chunkEmbeddingText(sourceText, options),
  };
}
