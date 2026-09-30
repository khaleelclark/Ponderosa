import { noteBackgroundRateLimit } from "../../api/backgroundCooldown.js";

/** Consume PDF.js chunks, never the page-wide getTextContent() accumulator. */
export async function readPdfText(
  stream: ReadableStream<{ items: Array<{ str?: string }> }>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  let cancellation: Promise<void> | undefined;
  // PDF.js requires an Error reason; omitting it leaves its worker-side stream
  // open even though the native reader has already closed.
  const cancel = () => cancellation ??= reader.cancel(signal.reason instanceof Error
    ? signal.reason : new Error("PDF text preview stopped")).catch(() => {});
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", items = 0;
  try {
    while (items < 2048 && text.length < 64_000) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      for (const item of chunk.value.items) {
        if (items >= 2048) break;
        items++;
        if (typeof item.str === "string") {
          if (text) text += " ";
          text += item.str.slice(0, 64_000 - text.length);
        }
        if (text.length >= 64_000) break;
      }
    }
    return text.replace(/[\uD800-\uDBFF]$/u, "");
  } finally {
    signal.removeEventListener("abort", abort);
    await cancel();
    reader.releaseLock();
  }
}

/** Read a scoped file as inert bytes, without redirects or an unbounded body. */
export async function readPdfPreview(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/")) throw new Error("Invalid PDF preview URL");
  const response = await fetch(target.href, { signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (response.status === 429) noteBackgroundRateLimit(response.headers.get("Retry-After"));
  if (!response.ok) throw new Error(`PDF could not be loaded (${response.status})`);
  const limit = 80 * 1024 * 1024;
  const tooLarge = () => new Error("This PDF exceeds the 80 MiB preview limit. Download it to open it elsewhere.");
  if (Number(response.headers.get("Content-Length")) > limit) { await response.body?.cancel(); throw tooLarge(); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The PDF response is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw tooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
