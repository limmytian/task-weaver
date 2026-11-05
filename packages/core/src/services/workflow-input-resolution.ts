import { asc, eq, inArray } from "drizzle-orm";
import { documents, documentFileVersions, requirements, workflowInputs, workflowOutputs, type Database } from "@task-weaver/db";
import { NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { attachmentStorage } from "./attachment-storage";
import { lockIdentityLifecycle } from "./auth-security";
import { requireResource, resourceAuthority } from "./resource-authorization";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ResolvedWorkflowInput =
  | { inputId: string; status: "available"; outputId: string; sourceRequirementId: string; documentId: string; fileVersionId: string; version: number; sha256: string }
  | { inputId: string; status: "unavailable"; reason: "inaccessible" | "missing" | "local_only" | "unverified" | "changed" | "unsupported" };

/**
 * Resolve within the caller's transaction. Lock order: identity lifecycle, target
 * requirement, inputs, outputs, source requirements, documents, file versions;
 * rows within each group are locked by ID. Callers must retain the transaction
 * until they have consumed the result. No source metadata is returned on denial.
 */
export async function resolveWorkflowInputs(tx: Transaction, context: VerifiedRequestContext, requirementId: string): Promise<ResolvedWorkflowInput[]> {
  await lockIdentityLifecycle(tx);
  const authority = await resourceAuthority(tx, context);
  const db = tx as unknown as Database;
  await requireResource(db, authority, "requirement", requirementId);
  await tx.select({ id: requirements.id }).from(requirements).where(eq(requirements.id, requirementId)).for("share");
  const inputs = await tx.select().from(workflowInputs).where(eq(workflowInputs.requirementId, requirementId)).orderBy(asc(workflowInputs.id)).for("share");
  if (!inputs.length) return [];
  const outputs = await tx.select().from(workflowOutputs).where(inArray(workflowOutputs.id, inputs.map(i => i.outputId))).orderBy(asc(workflowOutputs.id)).for("share");
  const sourceIds = [...new Set(outputs.map(o => o.requirementId))].sort();
  if (sourceIds.length) await tx.select({ id: requirements.id }).from(requirements).where(inArray(requirements.id, sourceIds)).orderBy(asc(requirements.id)).for("share");
  const documentIds = [...new Set(outputs.flatMap(o => o.type === "attachment" && o.referenceId ? [o.referenceId] : o.type === "local" && o.promotedDocumentId ? [o.promotedDocumentId] : []))].sort();
  const docs = documentIds.length ? await tx.select().from(documents).where(inArray(documents.id, documentIds)).orderBy(asc(documents.id)).for("share") : [];
  const versionIds = [...new Set(outputs.flatMap(o => o.attachmentFileVersionId ? [o.attachmentFileVersionId] : []))].sort();
  const versions = versionIds.length ? await tx.select().from(documentFileVersions).where(inArray(documentFileVersions.id, versionIds)).orderBy(asc(documentFileVersions.id)).for("share") : [];
  const result: ResolvedWorkflowInput[] = [];
  for (const input of inputs) {
    const unavailable = (reason: Extract<ResolvedWorkflowInput, { status: "unavailable" }>["reason"]) => result.push({ inputId: input.id, status: "unavailable", reason });
    const output = outputs.find(o => o.id === input.outputId);
    if (!output) { unavailable("missing"); continue; }
    try { await requireResource(db, authority, "requirement", output.requirementId); }
    catch (error) { if (!(error instanceof NotFoundError)) throw error; unavailable("inaccessible"); continue; }
    if (output.availability !== "available") { unavailable(output.availability === "changed" ? "changed" : "missing"); continue; }
    const documentId = output.type === "attachment" ? output.referenceId : output.type === "local" ? output.promotedDocumentId : null;
    if (output.type === "local" && !documentId) { unavailable("local_only"); continue; }
    if (!documentId) { unavailable("unsupported"); continue; }
    try { await requireResource(db, authority, "document", documentId); }
    catch (error) { if (!(error instanceof NotFoundError)) throw error; unavailable("inaccessible"); continue; }
    const doc = docs.find(d => d.id === documentId);
    const file = versions.find(v => v.id === output.attachmentFileVersionId && v.documentId === documentId);
    if (!doc || !file) { unavailable("missing"); continue; }
    if (doc.currentFileVersionId !== file.id) { unavailable("changed"); continue; }
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || (output.type === "local" && (output.sha256 !== file.sha256 || output.sizeBytes !== file.sizeBytes))) { unavailable("unverified"); continue; }
    if (file.storageBackend !== "local") { unavailable("unverified"); continue; }
    try {
      const verified = await attachmentStorage().getVerifiedObject(file.objectKey, { sha256: file.sha256, sizeBytes: file.sizeBytes });
      verified.body.destroy();
    } catch { unavailable("unverified"); continue; }
    result.push({ inputId: input.id, status: "available", outputId: output.id, sourceRequirementId: output.requirementId, documentId, fileVersionId: file.id, version: file.version, sha256: file.sha256 });
  }
  return result;
}
