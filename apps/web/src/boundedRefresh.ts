/** Fixed-window refresh: frequent events cannot postpone work forever, and a
 * terminal change may bring a pending refresh forward. */
export function createBoundedRefresh(
  run: () => void,
  regularDelayMs: number,
  urgentDelayMs = 150,
): { schedule(urgent?: boolean): void; flush(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  return {
    schedule(urgent = false) {
      const nextDueAt = Date.now() + (urgent ? urgentDelayMs : regularDelayMs);
      if (timer && dueAt <= nextDueAt) return;
      if (timer) clearTimeout(timer);
      dueAt = nextDueAt;
      timer = setTimeout(() => {
        timer = undefined;
        dueAt = 0;
        run();
      }, Math.max(0, nextDueAt - Date.now()));
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      dueAt = 0;
      run();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      dueAt = 0;
    },
  };
}

/** Leading refresh with a trailing guarantee and a true minimum interval.
 * Unlike createBoundedRefresh, repeated urgent events cannot exceed the rate. */
export function createRateLimitedRefresh(
  run: () => void,
  intervalMs: number,
  initialDelayMs = 150,
): { schedule(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAllowedAt = 0;
  return {
    schedule() {
      if (timer) return;
      const dueAt = Math.max(Date.now() + initialDelayMs, nextAllowedAt);
      timer = setTimeout(() => {
        timer = undefined;
        nextAllowedAt = Date.now() + intervalMs;
        run();
      }, Math.max(0, dueAt - Date.now()));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Coalesce equivalent query identities within a fixed window. New events do
 * not postpone a pending refresh; query visibility remains the caller's rule. */
export function createCoalescedQueryRefresh(
  invalidate: (queryKey: readonly unknown[]) => void,
  delayMs = 250,
): { schedule(queryKey: readonly unknown[]): void; dispose(): void } {
  let disposed = false;
  const pending = new Map<string, readonly unknown[]>();
  const refresh = createBoundedRefresh(() => {
    const queries = [...pending.values()];
    pending.clear();
    for (const queryKey of queries) invalidate(queryKey);
  }, delayMs);
  return {
    schedule(queryKey) {
      if (disposed) return;
      pending.set(JSON.stringify(queryKey), queryKey);
      refresh.schedule();
    },
    dispose() {
      disposed = true;
      refresh.dispose();
      pending.clear();
    },
  };
}
