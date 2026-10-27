import { evidenceLimits } from './schemas/evidence';

export type EvidenceTextPreview = { text: string; sampledBytes: number; truncated: boolean; encoding: 'utf-8' | 'unsupported' };
/** Decode a bounded sample as inert text; callers must escape it when rendering. */
export function evidenceTextPreview(bytes: Uint8Array, totalBytes: number): EvidenceTextPreview {
  const sample = bytes.subarray(0, evidenceLimits.previewBytes);
  const truncated = totalBytes > sample.length || bytes.length > sample.length;
  try {
    // The byte limit may split a final UTF-8 code point; trim only that trailing fragment.
    let end = sample.length;
    if (truncated) {
      let i = end - 1;
      while (i >= 0 && (sample[i]! & 0xc0) === 0x80 && end - i <= 3) i--;
      if (i >= 0) {
        const lead = sample[i]!;
        const need = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
        if (end - i < need) end = i;
      }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
    if (text.includes('\0')) throw new Error('Binary input');
    return { text, sampledBytes: end, truncated, encoding: 'utf-8' };
  } catch { return { text: '', sampledBytes: sample.length, truncated, encoding: 'unsupported' }; }
}

/** Parse quoted CSV/TSV without interpreting formulas or creating HTML. */
export function evidenceTablePreview(text: string, delimiter: ',' | '\t'): { rows: string[][]; truncated: boolean; malformed: boolean } {
  const maxCell = 4096; const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let afterQuote = false; let malformed = false; let truncated = false;
  const pushCell = () => { if (row.length < evidenceLimits.tableColumns) row.push(cell); else truncated = true; cell = ''; afterQuote = false; };
  const pushRow = () => { pushCell(); if (rows.length < evidenceLimits.tableRows) rows.push(row); else truncated = true; row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { if (cell.length < maxCell) cell += '"'; else truncated = true; i++; } else { quoted = false; afterQuote = true; } }
      else if (cell.length < maxCell) cell += char; else truncated = true;
      continue;
    }
    if (afterQuote && char !== delimiter && char !== '\r' && char !== '\n') malformed = true;
    if (char === '"' && !cell && !afterQuote) { quoted = true; continue; }
    if (char === delimiter) { pushCell(); continue; }
    if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); if (rows.length >= evidenceLimits.tableRows && i < text.length - 1) { truncated = true; break; } continue; }
    if (char === '"') malformed = true;
    if (cell.length < maxCell) cell += char; else truncated = true;
  }
  if (quoted) malformed = true;
  if (row.length || cell || afterQuote || !rows.length) pushRow();
  return { rows, truncated, malformed };
}

export type EvidencePreviewKind = 'text' | 'csv' | 'tsv' | 'image' | 'audio' | 'video' | 'pdf' | 'download';
/** Only explicit safe content types are eligible; active and unknown content is download-only. */
export function evidencePreviewKind(mimeType: string, sizeBytes: number): EvidencePreviewKind {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return 'download';
  if (['text/plain', 'text/markdown'].includes(mime)) return 'text';
  if (mime === 'text/csv') return 'csv';
  if (mime === 'text/tab-separated-values') return 'tsv';
  if (sizeBytes > evidenceLimits.mediaPreviewBytes) return 'download';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime)) return 'image';
  if (['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4'].includes(mime)) return 'audio';
  if (['video/mp4', 'video/webm', 'video/ogg'].includes(mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'download';
}
