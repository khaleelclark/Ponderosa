const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Fetch as data: download response headers must never cause browser navigation. */
export async function readTextPreview(url: string, signal: AbortSignal): Promise<{ content: string; truncated: boolean }> {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/")) {
    throw new Error("Invalid attachment URL");
  }
  const response = await fetch(target.href, { signal, cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`File could not be loaded (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("File response is unavailable");
  const decoder = new TextDecoder();
  let remaining = MAX_PREVIEW_BYTES;
  let content = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { content: content + decoder.decode(), truncated: false };
      const chunk = value.subarray(0, remaining);
      content += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
      if (chunk.byteLength < value.byteLength) return { content, truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
