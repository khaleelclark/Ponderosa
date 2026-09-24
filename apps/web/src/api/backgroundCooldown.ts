const STORAGE_KEY = "ponderosa.background-retry-after.v1";
const MAX_COOLDOWN_MS = 5 * 60_000;
let localUntil = 0;

export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - now;
  return Number.isFinite(delay)
    ? Math.max(1_000, Math.min(MAX_COOLDOWN_MS, Math.ceil(delay)))
    : 1_000;
}

export function backgroundCooldownRemaining(now = Date.now()): number {
  let sharedUntil = 0;
  try {
    sharedUntil = Number(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 0);
  } catch {
    // Private browsing may disallow storage; this tab still honors its cooldown.
  }
  const until = Math.max(localUntil, Number.isFinite(sharedUntil) ? sharedUntil : 0);
  return Math.max(0, Math.min(MAX_COOLDOWN_MS, until - now));
}

export function noteBackgroundRateLimit(retryAfter: string | null, now = Date.now()): number {
  localUntil = Math.max(localUntil, now + backgroundCooldownRemaining(now), now + parseRetryAfter(retryAfter, now));
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(localUntil));
  } catch {
    // A single tab still observes its in-memory deadline.
  }
  return localUntil - now;
}

export async function waitForBackgroundCooldown(signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const remaining = backgroundCooldownRemaining();
    if (!remaining) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, remaining);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
