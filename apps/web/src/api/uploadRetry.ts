import { ApiRequestError } from "./types.js";

const MAX_CONTENTION_RETRIES = 6;
const MAX_CONTENTION_WINDOW_MS = 45_000;

function uploadSlotBusy(error: unknown): error is ApiRequestError {
  if (!(error instanceof ApiRequestError) || error.status !== 503) return false;
  const body = error.body;
  return Boolean(body && typeof body === "object" &&
    "code" in body && body.code === "attachment_upload_busy");
}

/** Retry only the server's upload-slot rejection. The original File and
 * operation identity are reused; other 503s and ambiguous upload failures
 * remain visible rather than repeating a possibly completed mutation. */
export async function retryContendedAttachmentUpload<T>(
  upload: () => Promise<T>,
  shouldRetry: () => boolean = () => true,
  wait: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const deadline = Date.now() + MAX_CONTENTION_WINDOW_MS;
  for (let retries = 0;; retries += 1) {
    try {
      return await upload();
    } catch (error) {
      if (!uploadSlotBusy(error) || retries >= MAX_CONTENTION_RETRIES || !shouldRetry()) throw error;
      const backoff = Math.min(1_000 * 2 ** retries, 8_000);
      const delay = Math.max(error.retryAfterMs ?? 1_000, backoff) + Math.floor(Math.random() * 250);
      if (Date.now() + delay > deadline) throw error;
      await wait(delay);
      if (!shouldRetry()) throw error;
    }
  }
}
