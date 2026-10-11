"use client";

import { PdfAttachmentPreview } from "@/components/pdf-attachment-preview";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { uploadAttachment } from "@/lib/attachment-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AttachmentDocument({ id, documentVersion }: { id: string; documentVersion: number }) {
  const utils = trpc.useUtils();
  const versions = trpc.document.fileVersions.useQuery({ id });
  const [selected, setSelected] = useState("current");
  const [replacement, setReplacement] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const file = selected === "current" ? versions.data?.[0] : versions.data?.find((entry) => String(entry.version) === selected);
  const download = `/api/attachments/${id}${selected === "current" ? "" : `?fileVersion=${selected}`}`;
  const preview = `${download}${download.includes("?") ? "&" : "?"}preview=true`;
  const image = file && ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(file.mimeType);
  const pdf = file?.mimeType === "application/pdf";
  const frame = file?.mimeType === "text/plain";

  async function replace() {
    if (!replacement) return;
    setUploading(true);
    try {
      await uploadAttachment(replacement, { originalFilename: replacement.name, mimeType: replacement.type || "application/octet-stream", expectedVersion: documentVersion }, id);
      await Promise.all([utils.document.get.invalidate({ id }), utils.document.list.invalidate(), utils.document.fileVersions.invalidate({ id })]);
      setReplacement(null);
      setSelected("current");
      setPreviewFailed(false);
      toast.success("File replaced; previous versions remain available");
    } catch (error) {
      toast.error("Replacement failed", { description: error instanceof Error ? error.message : "Please retry" });
    } finally { setUploading(false); }
  }

  return <section className="not-prose space-y-4 rounded-lg border p-4" aria-label="Attachment file">
    {versions.isError && <p role="alert">Unable to load file history. <Button variant="outline" onClick={() => versions.refetch()}>Retry</Button></p>}
    {versions.isLoading && <p>Loading file history...</p>}
    {file && <>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selected} onValueChange={(value) => { setSelected(value); setPreviewFailed(false); }}>
          <SelectTrigger className="w-60" aria-label="File version"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="current">Current file</SelectItem>{versions.data?.map((entry) => <SelectItem key={entry.id} value={String(entry.version)}>File v{entry.version} · {new Date(entry.createdAt).toLocaleDateString()}</SelectItem>)}</SelectContent>
        </Select>
        <Button asChild variant="outline"><a href={download}>Download original file</a></Button>
      </div>
      <p className="break-all text-sm">{file.originalFilename} · {file.mimeType} · {file.sizeBytes.toLocaleString()} bytes · file v{file.version}</p>
      <p className="break-all text-xs text-muted-foreground">SHA-256: {file.sha256}</p>
      {!previewFailed && image && (
        // The authenticated original-byte endpoint must bypass image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img key={preview} src={preview} alt={file.originalFilename} className="max-h-[36rem] max-w-full object-contain" onError={() => setPreviewFailed(true)} />
      )}
      {pdf && <PdfAttachmentPreview key={preview} src={preview} filename={file.originalFilename} />}
      {!previewFailed && frame && <iframe key={preview} src={preview} title={`Preview: ${file.originalFilename}`} sandbox="allow-same-origin" className="h-[36rem] w-full rounded border" onError={() => setPreviewFailed(true)} />}
      {(!image && !frame && !pdf || previewFailed) && <p className="text-sm text-muted-foreground">Preview unavailable for this file. Download the original to open it locally.</p>}
      {frame && <p className="text-xs text-muted-foreground">If your browser cannot display the preview, use Download original file.</p>}
    </>}
    <div className="space-y-2 border-t pt-4">
      <label className="text-sm font-medium" htmlFor="replacement-file">Replace file</label>
      <Input id="replacement-file" type="file" disabled={uploading} onChange={(event) => setReplacement(event.target.files?.[0] ?? null)} />
      <Button disabled={!replacement || uploading} onClick={replace}>{uploading ? "Uploading..." : "Upload new file version"}</Button>
      <p className="text-xs text-muted-foreground">Replacement preserves the document and its links. Metadata edits do not duplicate file bytes.</p>
    </div>
  </section>;
}
