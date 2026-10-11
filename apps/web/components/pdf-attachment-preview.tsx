"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button } from "@/components/ui/button";

export function PdfAttachmentPreview({ src, filename }: { src: string; filename: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    async function load() {
      try {
        const library = await import("pdfjs-dist");
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const task = library.getDocument({
          url: src,
          withCredentials: true,
          enableXfa: false,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        destroy = () => task.destroy();
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    }
    void load();
    return () => { cancelled = true; void destroy?.(); };
  }, [src]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    async function render() {
      setLoading(true);
      try {
        const page = await pdf!.getPage(pageNumber);
        if (cancelled || !canvas.current) return;
        const viewport = page.getViewport({ scale: 1.5 });
        const output = canvas.current;
        // Bound raster memory for PDFs with unusually large page dimensions.
        const scale = Math.min(2, 2048 / Math.max(viewport.width, viewport.height));
        output.width = Math.floor(viewport.width * scale);
        output.height = Math.floor(viewport.height * scale);
        renderTask = page.render({ canvas: output, viewport, transform: [scale, 0, 0, scale, 0, 0] });
        await renderTask.promise;
        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    }
    void render();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, pageNumber]);

  return <div className="space-y-3" aria-label="PDF preview">
    {error ? <p role="alert" className="text-sm text-muted-foreground">PDF preview unavailable. Download the original to open it locally.</p> : <>
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading PDF preview...</p>}
      <div className="max-h-[36rem] overflow-auto rounded border bg-muted p-2">
        <canvas ref={canvas} aria-label={`Preview: ${filename}, page ${pageNumber}`} className="mx-auto h-auto max-w-full" />
      </div>
      {pdf && <div className="flex items-center gap-3">
        <Button variant="outline" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}>Previous page</Button>
        <span className="text-sm">Page {pageNumber} of {pdf.numPages}</span>
        <Button variant="outline" disabled={loading || pageNumber >= pdf.numPages} onClick={() => setPageNumber(pageNumber + 1)}>Next page</Button>
      </div>}
    </>}
  </div>;
}
