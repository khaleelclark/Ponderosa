import { ApiRequestError } from "./types.js";
import { backgroundCooldownRemaining } from "./backgroundCooldown.js";

/** One retry after the shared 429 window is enough to reconcile a final state;
 * repeatedly retrying inside that window only consumes more admission. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  // TanStack passes 1 for the first failed attempt. Allow one retry only,
  // after the shared Retry-After window, then surface the limit to the UI.
  if (error instanceof ApiRequestError && error.status === 429) return failureCount <= 1;
  if (error instanceof ApiRequestError && (error.body as { code?: string } | undefined)?.code === "PROVIDER_INACTIVE") return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return failureCount < 3;
}

export function queryRetryDelay(failureCount: number, error: unknown): number {
  if (error instanceof ApiRequestError && error.status === 429) {
    return Math.max(error.retryAfterMs ?? 1_000, backgroundCooldownRemaining())
      + Math.floor(Math.random() * 2_000);
  }
  return Math.min(1_000 * 2 ** failureCount, 30_000);
}
