import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdfPreview, readPdfText } from "./readPdfPreview";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href;

/** One page/canvas at a time: no document scripts, forms, or external links. */
export default function PdfPreview({ url, title }: { url: string; title: string }): JSX.Element {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<string>();
  const [rendering, setRendering] = useState(true);
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  // A resize may replace a pending render, but must not renew its deadline.
  // A completed preview, deliberate page change, or explicit retry starts a
  // new bounded attempt. Loading and the initial paint share one budget.
  const budget = useRef({ page: 1, expires: 0, pending: true });
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const value = Math.floor(entries[0]?.contentRect.width ?? 640);
      if (value > 0) setWidth(value);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    let disposed = false;
    budget.current = { page: 1, expires: Date.now() + 30_000, pending: true };
    const timeout = setTimeout(() => {
      abort.abort(); void task?.destroy().catch(() => {});
      if (!disposed) { setRendering(false); setError("PDF preview took too long to load. Try again, or use Open or Download."); }
    }, 30_000);
    setDocument(undefined); setPageNumber(1); setError(undefined); setRendering(true); setText("");
    void readPdfPreview(url, abort.signal).then(bytes => {
      if (abort.signal.aborted) return;
      task = getDocument({ data: bytes, enableXfa: false, maxImageSize: 4_000_000, stopAtErrors: true,
        cMapUrl: "/static/pdfjs/6.3.289/cmaps/", cMapPacked: true,
        standardFontDataUrl: "/static/pdfjs/6.3.289/standard_fonts/",
        wasmUrl: "/static/pdfjs/6.3.289/decoders/", useWasm: false });
      return task.promise.then(pdf => { if (!abort.signal.aborted) setDocument(pdf); });
    }).catch(() => {
      if (!disposed && !abort.signal.aborted) { setRendering(false); setError("PDF preview could not be loaded. Try again, or use Open or Download."); }
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); abort.abort(); void task?.destroy().catch(() => {}); };
  }, [url, attempt]);
  useEffect(() => {
    if (!document || !canvas.current || error) return;
    let cancelled = false;
    let painted = false;
    const extraction = new AbortController();
    let task: RenderTask | undefined;
    const element = canvas.current;
    if (budget.current.page !== pageNumber || !budget.current.pending) {
      budget.current = { page: pageNumber, expires: Date.now() + 30_000, pending: true };
    }
    const timeout = setTimeout(() => {
      cancelled = true; task?.cancel(); extraction.abort();
      if (!painted) { setRendering(false); setError("This PDF page took too long to process. Try again, or use Open or Download."); }
    }, Math.max(0, budget.current.expires - Date.now()));
    setRendering(true); setText("");
    void document.getPage(pageNumber).then(async page => {
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      // Keep each canvas below four million pixels, including HiDPI output.
      const scale = Math.min(width / natural.width, 1200 / natural.width, Math.sqrt(4_000_000 / (natural.width * natural.height)));
      const viewport = page.getViewport({ scale });
      const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(4_000_000 / (viewport.width * viewport.height)), 2);
      element.width = Math.max(1, Math.floor(viewport.width * density));
      element.height = Math.max(1, Math.floor(viewport.height * density));
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      task = page.render({ canvas: element, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      await task.promise;
      if (cancelled) return;
      painted = true; budget.current.pending = false;
      setRendering(false);
      const content = await readPdfText(page.streamTextContent(), extraction.signal).catch(() => undefined);
      if (!cancelled && content !== undefined) setText(content);
    }).catch(error => { if (!cancelled && error?.name !== "RenderingCancelledException") { setRendering(false); setError("This PDF page could not be displayed. Use Open or Download to inspect it."); } })
      .finally(() => clearTimeout(timeout));
    // Retain the canvas footprint while replacing a render. Removing it toggles
    // the modal scrollbar, which changes width and cancels the next render too.
    return () => { cancelled = true; clearTimeout(timeout); task?.cancel(); extraction.abort(); };
  }, [document, pageNumber, width, error]);
  return <Box ref={container} sx={{ minWidth: 0, p: 1 }} aria-label={`PDF preview: ${title}`}>
    {error ? <Alert severity="error" action={<Button color="inherit" onClick={() => setAttempt(value => value + 1)}>Try again</Button>}>{error}</Alert> : null}
    {document ? <Stack direction="row" spacing={1} role="group" aria-label="PDF page controls" tabIndex={-1} sx={{ alignItems: "center", justifyContent: "center", mb: 1 }}>
      <Button disabled={pageNumber === 1 || Boolean(error)} onClick={event => {
        // WebKit drops focus to body when the clicked button becomes disabled.
        // Keep Escape inside the modal at the first/last page boundary.
        if (pageNumber === 2) event.currentTarget.parentElement?.focus({ preventScroll: true });
        setPageNumber(value => value - 1);
      }}>Previous page</Button>
      <Typography variant="caption">Page {pageNumber} of {document.numPages}</Typography>
      <Button disabled={pageNumber === document.numPages || Boolean(error)} onClick={event => {
        if (pageNumber === document.numPages - 1) event.currentTarget.parentElement?.focus({ preventScroll: true });
        setPageNumber(value => value + 1);
      }}>Next page</Button>
    </Stack> : null}
    <Box sx={{ position: "relative", minHeight: error ? 0 : 120 }}>
      {!error && rendering ? <Stack role="status" direction="row" spacing={1} sx={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", p: 2 }}><CircularProgress size={20}/><Typography>Loading PDF…</Typography></Stack> : null}
      <Box component="canvas" ref={canvas} role="img" aria-label={`${title}, page ${pageNumber}`} sx={{ display: error ? "none" : "block", visibility: rendering ? "hidden" : "visible", maxWidth: "100%", mx: "auto", bgcolor: "white" }}/>
    </Box>
    <Box sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)" }}>{text}</Box>
  </Box>;
}
