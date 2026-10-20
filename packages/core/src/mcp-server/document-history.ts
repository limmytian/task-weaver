import { and, desc, eq, sql } from "drizzle-orm";
import { documentVersions, type Database } from "@task-weaver/db";
import { NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "../services/auth-security";
import { requireResource, resourceAuthority } from "../services/resource-authorization";

const columns = { id: documentVersions.id, documentId: documentVersions.documentId, version: documentVersions.version, title: sql<string>`left(${documentVersions.title}, 128)`, docType: documentVersions.docType, changeType: documentVersions.changeType, changedBy: documentVersions.changedBy, changedByType: documentVersions.changedByType, changeDescription: sql<string | null>`left(${documentVersions.changeDescription}, 256)`, createdAt: documentVersions.createdAt };
const MAX_BYTES = 32768;
type HistoryInput = { id: string; offset: number; limit: number; version?: number };

export function boundedDocumentChunk<T extends { content: string; totalCharacters: number }>(record: T, offset: number) {
  const characters = Array.from(record.content);
  const value = (length: number) => ({ ...record, content: characters.slice(0, length).join(""), meta: { offset, offsetUnit: "unicode_characters", nextOffset: offset + length < record.totalCharacters ? offset + length : null, contentTruncated: offset > 0 || offset + length < record.totalCharacters, maxBytes: MAX_BYTES } });
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value(middle))) <= MAX_BYTES) low = middle; else high = middle - 1;
  }
  return value(low);
}

/** Authorization follows the current document; historical bodies never load with summaries. */
export async function readDocumentHistory(db: Database, identity: VerifiedRequestContext, operation: "list" | "read", input: HistoryInput) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    await requireResource(tx as unknown as Database, authority, "document", input.id);
    if (operation === "read") {
      const [record] = await tx.select({ ...columns, content: sql<string>`substring(${documentVersions.content} FROM ${input.offset + 1}::integer FOR ${input.limit}::integer)`, totalCharacters: sql<number>`length(${documentVersions.content})` }).from(documentVersions).where(and(eq(documentVersions.documentId, input.id), eq(documentVersions.version, input.version!))).limit(1);
      if (!record) throw new NotFoundError("Document revision not found");
      return boundedDocumentChunk(record, input.offset);
    }
    const rows = await tx.select(columns).from(documentVersions).where(eq(documentVersions.documentId, input.id)).orderBy(desc(documentVersions.version), documentVersions.id).limit(input.limit + 1).offset(input.offset);
    const result = { items: rows.slice(0, input.limit), meta: { offset: input.offset, limit: input.limit, nextOffset: null as number | null, hasMore: rows.length > input.limit, maxBytes: MAX_BYTES } };
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 128 && result.items.length) { result.items.pop(); result.meta.hasMore = true; }
    if (result.meta.hasMore) result.meta.nextOffset = input.offset + result.items.length;
    return result;
  });
}
