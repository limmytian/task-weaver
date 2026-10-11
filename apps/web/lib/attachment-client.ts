import { attachmentMetadataSchema, replaceAttachmentSchema } from "@task-weaver/contracts";

export async function uploadAttachment(file: File, metadata: unknown, id?: string) {
  const input = id ? replaceAttachmentSchema.parse(metadata) : attachmentMetadataSchema.parse(metadata);
  const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  if (!challenge.ok) throw new Error("Unable to authorize upload");
  const { csrfToken } = await challenge.json() as { csrfToken: string };
  const response = await fetch(id ? `/api/attachments/${encodeURIComponent(id)}` : "/api/attachments", { method: id ? "PUT" : "POST", credentials: "same-origin",
    headers: { "content-type": "application/octet-stream", "x-csrf-token": csrfToken, "x-tw-attachment-metadata": encodeURIComponent(JSON.stringify(input)) }, body: file });
  const result = await response.json() as { id: string; error?: string };
  if (!response.ok) throw new Error(result.error ?? "Upload failed");
  return result;
}
