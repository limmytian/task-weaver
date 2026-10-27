"use client";

import { useEffect, useState } from "react";
import { evidenceLimits, evidenceTablePreview, evidenceTextPreview } from "@task-weaver/contracts";

type Table = ReturnType<typeof evidenceTablePreview> & { sampled: boolean };
export function EvidenceTablePreview({ src, filename, sizeBytes, delimiter }: { src: string; filename: string; sizeBytes: number; delimiter: ',' | '\t' }) {
  const [value, setValue] = useState<Table | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(src, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Unavailable');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (size < evidenceLimits.previewBytes) {
            const { done, value } = await reader.read(); if (done) break;
            const part = value.subarray(0, evidenceLimits.previewBytes - size); chunks.push(part); size += part.length;
            if (part.length !== value.length || size === evidenceLimits.previewBytes) { await reader.cancel(); break; }
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
        const text = evidenceTextPreview(bytes, sizeBytes);
        if (text.encoding !== 'utf-8') throw new Error('Unsupported encoding');
        if (!controller.signal.aborted) setValue({ ...evidenceTablePreview(text.text, delimiter), sampled: text.truncated });
      } catch { if (!controller.signal.aborted) setError(true); }
    }
    void load(); return () => controller.abort();
  }, [src, sizeBytes, delimiter]);
  if (error) return <p role="alert">Table preview unavailable or encoding unsupported. Download the original to inspect it.</p>;
  if (!value) return <p role="status">Loading table preview…</p>;
  return <div className="space-y-2"><div className="max-h-96 overflow-auto rounded border"><table className="text-left"><caption className="sr-only">Preview: {filename}</caption><tbody>{value.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="max-w-64 whitespace-pre-wrap break-words border p-2">{cell}</td>)}</tr>)}</tbody></table></div>
    {(value.sampled || value.truncated) && <p>Preview is limited to 256 KiB, 100 rows, 50 columns and 4,096 characters per cell.</p>}
    {value.malformed && <p role="alert">The sample contains incomplete or malformed quoted fields.</p>}
    <p>Cells are displayed as text; formulas are not evaluated.</p>
  </div>;
}
