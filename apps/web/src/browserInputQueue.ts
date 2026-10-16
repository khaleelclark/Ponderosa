/** Ordered, bounded operator input. Never retry an action with an uncertain result. */
export function createBrowserInputQueue<T>({
  context, dispatch, onError, onBusy, coalesce, limit = 128,
}: {
  context(): string | undefined;
  dispatch(value: T, context: string): Promise<void>;
  onError(error: Error): void;
  onBusy?(busy: boolean): void;
  /** Combine only adjacent pending inputs; never repeat an in-flight action. */
  coalesce?(pending: T, next: T): T | undefined;
  limit?: number;
}) {
  const pending: { value: T; context: string }[] = [];
  let running = false;
  let disposed = false;
  let stopped = false;
  const fail = (message: string) => {
    pending.length = 0;
    stopped = true;
    if (!disposed) onError(new Error(message));
  };
  const drain = async () => {
    if (running || disposed || stopped) return;
    running = true;
    onBusy?.(true);
    try {
      while (pending.length && !disposed && !stopped) {
        const next = pending.shift()!;
        if (context() !== next.context) {
          fail("Browser control or the selected tab changed. Pending input was discarded.");
          break;
        }
        try { await dispatch(next.value, next.context); }
        catch {
          fail("Input could not be confirmed. Pending input was stopped, not replayed. Check the page before continuing.");
        }
      }
    } finally { running = false; if (!disposed) onBusy?.(false); }
  };
  return {
    activate() { disposed = false; },
    enqueue(value: T) {
      const current = context();
      if (disposed || stopped || !current) return;
      const tail = pending.at(-1);
      if (tail?.context === current) {
        const combined = coalesce?.(tail.value, value);
        if (combined !== undefined) { tail.value = combined; return; }
      }
      if (pending.length >= limit) {
        fail("Browser input is falling behind. Pending input was stopped. Check the page before continuing.");
        return;
      }
      pending.push({ value, context: current });
      void drain();
    },
    reset() { pending.length = 0; stopped = false; },
    dispose() { disposed = true; pending.length = 0; },
  };
}
