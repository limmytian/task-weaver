import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq } from "drizzle-orm";
import { documents, documentVersions, documentFileVersions, documentFileGarbage, workflowOutputs, requirements, activityLog, type Database } from "@task-weaver/db";
import { attachmentMetadataSchema, attachmentFileMetadataSchema, replaceAttachmentSchema, attachmentFileQuerySchema, AuthorizationError, ConflictError, NotFoundError, ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, requireResource, requireScope } from "./resource-authorization";
import { lockIdentityLifecycle } from "./auth-security";
import { attachmentStorage } from "./attachment-storage";
import { authenticationFailure } from "./auth-runtime";
import { emit } from "@task-weaver/realtime";
import { evidenceAttachmentMetadata } from "./evidence-metadata";
export { evidenceAttachmentMetadata } from "./evidence-metadata";

type FileVersion = typeof documentFileVersions.$inferSelect;
export function publicAttachmentFile(row: FileVersion) {
  return attachmentFileMetadataSchema.parse(row);
}

/** Original content is never passed to document search or embedding services. */
export function createAttachmentService(identity: VerifiedRequestContext) {
  async function authority(db: Database) {
    const live = await resourceAuthority(db, identity);
    if (live.bounds) throw new AuthorizationError();
    return live;
  }
  async function document(db: Database, id: string, write = false) {
    const live = await authority(db);
    await requireResource(db, live, "document", id, write ? "resource.write" : "resource.read");
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    if (!row || row.form !== "attachment") throw new NotFoundError("Attachment document not found");
    return { row, live };
  }
  return {
    async create(db: Database, value: unknown, body: Readable) {
      const input = attachmentMetadataSchema.parse(value);
      const live = await authority(db);
      const scope = input.projectId ? { projectId: input.projectId } : {
        personalOwnerId: input.personalOwnerId ?? (live.actor.type === "human" ? live.actor.id : live.actor.managedByActorId),
        personalOwnerType: input.personalOwnerType ?? "human" as const,
      };
      if (input.projectId && (input.personalOwnerId || input.personalOwnerType)) throw new ValidationError("Choose one document scope");
      requireScope(live, scope);
      if (input.projectId) await requireResource(db, live, "project", input.projectId, "resource.write");
      const storage = attachmentStorage(), objectKey = `attachments/${randomUUID()}/${randomUUID()}`;
      const object = await storage.putObject({ key: objectKey, body });
      try {
        const result = await db.transaction(async tx => {
          await lockIdentityLifecycle(tx);
          const txDb = tx as unknown as Database;
          const current = await authority(txDb); requireScope(current, scope);
          if (input.projectId) await requireResource(txDb, current, "project", input.projectId, "resource.write");
          const [doc] = await tx.insert(documents).values({ ...scope, form: "attachment", title: input.title, content: "", summary: input.description,
            tags: input.tags, docType: "other", readingTimeMin: null, createdBy: current.actor.id }).returning();
          const [file] = await tx.insert(documentFileVersions).values({ documentId: doc!.id, version: 1, originalFilename: input.originalFilename,
            mimeType: input.mimeType, sizeBytes: object.sizeBytes, sha256: object.sha256, objectKey, storageBackend: object.backend,
            createdBy: current.actor.id, createdByType: current.actor.type }).returning();
          const [published] = await tx.update(documents).set({ currentFileVersionId: file!.id }).where(eq(documents.id, doc!.id)).returning();
          await tx.insert(documentVersions).values({ documentId: doc!.id, version: 1, title: doc!.title, content: "", summary: doc!.summary,
            docType: doc!.docType, fileVersionId: file!.id, changeType: "created", changedBy: current.actor.id, changedByType: current.actor.type });
          await tx.insert(activityLog).values({ entityType: "document", entityId: doc!.id, action: "attachment_created", actorId: current.actor.id, actorType: current.actor.type,
            metadata: { fileVersionId: file!.id, sizeBytes: file!.sizeBytes, sha256: file!.sha256 } });
          return { ...published!, file: publicAttachmentFile(file!) };
        });
        emit({ type: "document_created", projectId: result.projectId, documentId: result.id, title: result.title });
        return result;
      } catch (error) { await storage.deleteObject(objectKey).catch(() => {}); throw error; }
    },
    async promoteEvidence(db: Database, requirementId: string, outputId: string, body: Readable) {
      const live = await authority(db);
      await requireResource(db, live, "requirement", requirementId, "resource.write");
      const before = await db.query.workflowOutputs.findFirst({ where: and(eq(workflowOutputs.id, outputId), eq(workflowOutputs.requirementId, requirementId)) });
      if (!before || before.type !== "local" || before.availability !== "available" || before.sizeBytes === null || !before.sha256) throw new NotFoundError("Evidence is unavailable");
      const storage = attachmentStorage(), objectKey = `attachments/${randomUUID()}/${randomUUID()}`;
      const object = await storage.putObject({ key: objectKey, body, sha256: before.sha256 });
      try {
        if (object.sizeBytes !== before.sizeBytes) throw new ValidationError("Evidence fingerprint changed");
        const result = await db.transaction(async tx => {
          await lockIdentityLifecycle(tx);
          const database = tx as unknown as Database;
          const current = await authority(database);
          await requireResource(database, current, "requirement", requirementId, "resource.write");
          const [output] = await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.id, outputId), eq(workflowOutputs.requirementId, requirementId))).for("update");
          const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, requirementId));
          if (!output || !requirement || output.type !== "local" || output.availability !== "available" || output.sha256 !== before.sha256 || output.sizeBytes !== before.sizeBytes || output.nodePublicKey !== before.nodePublicKey) throw new ValidationError("Evidence changed during promotion");
          if (output.promotedDocumentId && output.attachmentFileVersionId) {
            const [existing] = await tx.select({ sha256: documentFileVersions.sha256, sizeBytes: documentFileVersions.sizeBytes }).from(documentFileVersions).innerJoin(documents, eq(documents.id, documentFileVersions.documentId)).where(and(eq(documentFileVersions.id, output.attachmentFileVersionId), eq(documents.id, output.promotedDocumentId), eq(documents.projectId, requirement.projectId)));
            if (!existing || existing.sha256 !== output.sha256 || existing.sizeBytes !== output.sizeBytes) throw new ValidationError("Promoted evidence identity does not match");
            return { documentId: output.promotedDocumentId, fileVersionId: output.attachmentFileVersionId, replayed: true, projectId: requirement.projectId };
          }
          const [doc] = await tx.insert(documents).values({ projectId: requirement.projectId, form: "attachment", title: `Evidence ${output.id}`, content: "", docType: "other", readingTimeMin: null, createdBy: current.actor.id }).returning();
          const [file] = await tx.insert(documentFileVersions).values({ documentId: doc!.id, version: 1, ...evidenceAttachmentMetadata(output.relativePath), sizeBytes: object.sizeBytes, sha256: object.sha256, objectKey, storageBackend: object.backend, createdBy: current.actor.id, createdByType: current.actor.type }).returning();
          await tx.update(documents).set({ currentFileVersionId: file!.id }).where(eq(documents.id, doc!.id));
          await tx.insert(documentVersions).values({ documentId: doc!.id, version: 1, title: doc!.title, content: "", docType: doc!.docType, fileVersionId: file!.id, changeType: "created", changedBy: current.actor.id, changedByType: current.actor.type });
          await tx.update(workflowOutputs).set({ promotedDocumentId: doc!.id, attachmentFileVersionId: file!.id }).where(eq(workflowOutputs.id, output.id));
          await tx.insert(activityLog).values({ entityType: "requirement", entityId: requirementId, action: "evidence.promoted", actorId: current.actor.id, actorType: current.actor.type, metadata: { outputId, documentId: doc!.id, fileVersionId: file!.id, sha256: file!.sha256 } });
          return { documentId: doc!.id, fileVersionId: file!.id, replayed: false, projectId: requirement.projectId };
        });
        if (result.replayed) await storage.deleteObject(objectKey).catch(() => {});
        else emit({ type: "document_created", projectId: result.projectId, documentId: result.documentId, title: `Evidence ${outputId}` });
        return result;
      } catch (error) { await storage.deleteObject(objectKey).catch(() => {}); throw error; }
    },
    async replace(db: Database, id: string, value: unknown, body: Readable) {
      const input = replaceAttachmentSchema.parse(value);
      const before = await document(db, id, true);
      if (before.row.version !== input.expectedVersion) throw new ConflictError("Document version changed", before.row.version);
      const storage = attachmentStorage(), objectKey = `attachments/${id}/${randomUUID()}`;
      const object = await storage.putObject({ key: objectKey, body });
      try {
        const result = await db.transaction(async tx => {
          await lockIdentityLifecycle(tx);
          const txDb = tx as unknown as Database;
          const { live } = await document(txDb, id, true);
          const [doc] = await tx.select().from(documents).where(eq(documents.id, id)).for("update");
          if (doc!.version !== input.expectedVersion) throw new ConflictError("Document version changed", doc!.version);
          const [latest] = await tx.select().from(documentFileVersions).where(eq(documentFileVersions.documentId, id)).orderBy(desc(documentFileVersions.version)).limit(1);
          const [file] = await tx.insert(documentFileVersions).values({ documentId: id, version: (latest?.version ?? 0) + 1, originalFilename: input.originalFilename,
            mimeType: input.mimeType, sizeBytes: object.sizeBytes, sha256: object.sha256, objectKey, storageBackend: object.backend,
            createdBy: live.actor.id, createdByType: live.actor.type }).returning();
          const [published] = await tx.update(documents).set({ currentFileVersionId: file!.id, version: doc!.version + 1, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
          await tx.insert(documentVersions).values({ documentId: id, version: published!.version, title: doc!.title, content: "", summary: doc!.summary,
            docType: doc!.docType, fileVersionId: file!.id, changeType: "updated", changedBy: live.actor.id, changedByType: live.actor.type, changeDescription: "Attachment file replaced" });
          await tx.insert(activityLog).values({ entityType: "document", entityId: id, action: "attachment_replaced", actorId: live.actor.id, actorType: live.actor.type,
            metadata: { fileVersionId: file!.id, sha256: file!.sha256 } });
          return { ...published!, file: publicAttachmentFile(file!) };
        });
        emit({ type: "document_updated", documentId: id });
        return result;
      } catch (error) { await storage.deleteObject(objectKey).catch(() => {}); throw error; }
    },
    async versions(db: Database, id: string) {
      await document(db, id);
      return (await db.select().from(documentFileVersions).where(eq(documentFileVersions.documentId, id)).orderBy(desc(documentFileVersions.version))).map(publicAttachmentFile);
    },
    async download(db: Database, id: string, fileVersion?: number) {
      const { row } = await document(db, id);
      const [file] = await db.select().from(documentFileVersions).where(and(eq(documentFileVersions.documentId, id),
        fileVersion === undefined ? eq(documentFileVersions.id, row.currentFileVersionId!) : eq(documentFileVersions.version, fileVersion)));
      if (!file) throw new NotFoundError("Attachment file version not found");
      if (file.storageBackend !== "local") throw new Error("Attachment storage backend unavailable");
      const object = await attachmentStorage().getVerifiedObject(file.objectKey, { sha256: file.sha256, sizeBytes: file.sizeBytes });
      return { file: publicAttachmentFile(file), body: object.body };
    },
  };
}

export async function cleanupAttachmentGarbage(db: Database) {
  const storage = attachmentStorage();
  const garbage = await db.select().from(documentFileGarbage).limit(100);
  for (const row of garbage) {
    if (row.storageBackend !== storage.backend) continue;
    await storage.deleteObject(row.objectKey);
    await db.delete(documentFileGarbage).where(eq(documentFileGarbage.objectKey, row.objectKey));
  }
}

export function attachmentPreviewType(mimeType: string) {
  if (["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "text/plain", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4", "video/mp4", "video/webm", "video/ogg"].includes(mimeType.toLowerCase())) return mimeType.toLowerCase();
  return null;
}

/** Hono and Next share raw streaming transfers and permission enforcement. */
export async function handleAttachmentRequest(db: Database, identity: VerifiedRequestContext, request: Request, id?: string, versions = false): Promise<Response> {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  try {
    const service = createAttachmentService(identity);
    if (request.method === "GET" && id) {
      if (versions) return Response.json(await service.versions(db, id), { headers });
      const query = attachmentFileQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
      const result = await service.download(db, id, query.fileVersion);
      const type = query.preview ? attachmentPreviewType(result.file.mimeType) : null;
      const filename = encodeURIComponent(result.file.originalFilename).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16)}`);
      return new Response(Readable.toWeb(result.body) as ReadableStream<Uint8Array>, { headers: { ...headers,
        "content-type": type ?? "application/octet-stream", "content-length": String(result.file.sizeBytes), "x-tw-file-sha256": result.file.sha256,
        "content-disposition": `${type ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
        "content-security-policy": "sandbox; default-src 'none'", "cross-origin-resource-policy": "same-origin" } });
    }
    if (!["POST", "PUT"].includes(request.method) || !request.body) return Response.json({ error: "Attachment body required" }, { status: 400, headers });
    const rawMetadata = request.headers.get("x-tw-attachment-metadata") ?? "";
    if (rawMetadata.length > 16_384) return Response.json({ error: "Attachment metadata too large" }, { status: 400, headers });
    let metadata: unknown;
    try { metadata = JSON.parse(decodeURIComponent(rawMetadata)); } catch { return Response.json({ error: "Invalid attachment metadata" }, { status: 400, headers }); }
    const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
    const result = request.method === "PUT" && id ? await service.replace(db, id, metadata, body) : await service.create(db, metadata, body);
    return Response.json(result, { status: request.method === "POST" ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Storage object exceeds max size")) return Response.json({ error: "Attachment exceeds upload limit" }, { status: 413, headers });
    const failure = authenticationFailure(error);
    return Response.json({ error: failure.error, code: failure.code }, { status: failure.status, headers });
  }
}
