"use client";

import { useEffect, useState } from "react";
import { readTextPreview } from "@/lib/text-attachment-preview";

export function TextAttachmentPreview({ src, filename, maximumBytes = 1024 * 1024 }: { src: string; filename: string; maximumBytes?: number }) {
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(src, { credentials: "same-origin", redirect: "error", signal: controller.signal });
        const result = await readTextPreview(response, maximumBytes);
        if (!controller.signal.aborted) setPreview(result);
      } catch { if (!controller.signal.aborted) setError(true); }
    }
    void load();
    return () => controller.abort();
  }, [src, maximumBytes]);
  if (error) return <p role="alert">Text preview unavailable. Download the original to open it locally.</p>;
  if (!preview) return <p role="status">Loading text preview...</p>;
  return <div>
    <pre aria-label={`Preview: ${filename}`} className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded border p-4 text-sm">{preview.text}</pre>
    {preview.truncated && <p className="mt-2 text-xs text-muted-foreground">Preview limited to the first {(maximumBytes / 1024).toLocaleString()} KiB. Download the original for the complete file.</p>}
  </div>;
}
