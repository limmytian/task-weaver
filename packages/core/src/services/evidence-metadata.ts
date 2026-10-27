/** Only the final filename is exposed; unknown or active formats stay download-only. */
export function evidenceAttachmentMetadata(relativePath: string | null) {
  const raw = relativePath?.split(/[\\/]/).at(-1) ?? "";
  const filename = raw.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 255).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") || "evidence.bin";
  const extension = filename.includes(".") ? filename.split(".").at(-1)!.toLowerCase() : "";
  const types: Record<string, string> = { txt: "text/plain", md: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", pdf: "application/pdf", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm" };
  return { originalFilename: filename, mimeType: types[extension] ?? "application/octet-stream" };
}
