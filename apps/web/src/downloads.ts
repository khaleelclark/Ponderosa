import {AGENT_PACKAGE_MAX_BYTES} from "@ponderosa/core";
import {productApiPath} from "./api/productScope.js";
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

export interface DownloadProgress { receivedBytes: number; totalBytes?: number }

export async function prepareDownload(url: string, filename: string, signal?: AbortSignal, onProgress?: (progress: DownloadProgress) => void): Promise<void> {
  const response = await fetch(productApiPath(url), { credentials: "same-origin", signal });
  if (response.status === 429) noteBackgroundRateLimit(response.headers.get("Retry-After"));
  if (!response.ok) throw new Error(response.status === 429 ? "Downloads are temporarily busy. Wait a moment and try again." : `Download could not start (${response.status}). Try again.`);
  const packageDownload=/\/api\/(?:branches\/engine\/)?agents\/[^/?#]+\/export(?:[?#]|$)/u.test(url);
  const maximum=packageDownload?AGENT_PACKAGE_MAX_BYTES:80*1024*1024;
  const limitMiB=maximum/(1024*1024);
  const limitError = () => new Error(`This download exceeds Ponderosa's ${limitMiB} MiB limit.`);
  const length = Number(response.headers.get("Content-Length"));
  if (length > maximum) { await response.body?.cancel(); throw limitError(); }
  const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : undefined;
  onProgress?.({ receivedBytes: 0, totalBytes });
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
      onProgress?.({ receivedBytes: size, totalBytes });
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let name = filename;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  const quoted = /filename="([^"]+)"/iu.exec(disposition)?.[1];
  try { name = encoded ? decodeURIComponent(encoded) : quoted ?? filename; } catch { /* safe caller fallback */ }
  signal?.throwIfAborted();
  downloadBlob(new Blob(chunks, { type: response.headers.get("Content-Type") ?? "application/octet-stream" }), name || "download", true);
}
