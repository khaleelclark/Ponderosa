import { noteBackgroundRateLimit } from "./api/backgroundCooldown.js";

/** Keep the URL alive until the browser has consumed the download handoff. */
export function downloadBlob(blob: Blob, filename: string, feedbackHandled = false): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  if (feedbackHandled) anchor.dataset.ponderosaDownloadFeedback = "handled";
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}

export async function prepareDownload(url: string, filename: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (response.status === 429) noteBackgroundRateLimit(response.headers.get("Retry-After"));
  if (!response.ok) throw new Error(response.status === 429 ? "Downloads are temporarily busy. Wait a moment and try again." : `Download could not start (${response.status}). Try again.`);
  // Portable packages encode up to 64 MiB of artifact bytes as base64; keep
  // their existing 96 MiB import/export envelope rather than imposing the
  // separate 80 MiB single-file limit on that encoded container.
  const limitMiB = /\/api\/agents\/[^/?#]+\/export(?:[?#]|$)/u.test(url) ? 96 : 80;
  const maximum = limitMiB * 1024 * 1024;
  const limitError = () => new Error(`This download exceeds Ponderosa's ${limitMiB} MiB limit.`);
  if (Number(response.headers.get("Content-Length")) > maximum) { await response.body?.cancel(); throw limitError(); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The download response was empty. Try again.");
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw limitError();
      chunks.push(chunk.value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let name = filename;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  const quoted = /filename="([^"]+)"/iu.exec(disposition)?.[1];
  try { name = encoded ? decodeURIComponent(encoded) : quoted ?? filename; } catch { /* safe caller fallback */ }
  downloadBlob(new Blob(chunks, { type: response.headers.get("Content-Type") ?? "application/octet-stream" }), name || "download", true);
}
