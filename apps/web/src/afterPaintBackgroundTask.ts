/** Yield through a paint before one cancellable background callback. */
export function afterPaintBackgroundTask(callback: () => void): () => void {
  let firstFrame = 0, secondFrame = 0, timer = 0;
  const abort = new AbortController();
  const run = () => { if (!abort.signal.aborted) callback(); };
  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      const scheduler = (window as Window & { scheduler?: {
        postTask(callback: () => void, options: { priority: "background"; signal: AbortSignal }): Promise<void>;
      } }).scheduler;
      if (scheduler) void scheduler.postTask(run, { priority: "background", signal: abort.signal })
        .catch(error => { if (error?.name !== "AbortError") reportError(error); });
      else timer = window.setTimeout(run, 0);
    });
  });
  return () => {
    abort.abort();
    cancelAnimationFrame(firstFrame);cancelAnimationFrame(secondFrame);clearTimeout(timer);
  };
}
