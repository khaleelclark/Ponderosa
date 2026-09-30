import { noteBackgroundRateLimit } from "../../api/backgroundCooldown.js";

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
