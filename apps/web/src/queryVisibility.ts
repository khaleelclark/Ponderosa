import type { QueryClient } from "@tanstack/react-query";

export function browserPageIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** A sustained failure requires a continuous foreground interval. Hidden time
 * never matures a warning; returning to the page starts a fresh bounded check. */
export function createForegroundTimer(run: () => void, delayMs: number) {
  const page = typeof document === "undefined" ? undefined : document;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const resume = () => {
    cancel();
    if (armed && browserPageIsVisible()) timer = setTimeout(() => { timer = undefined; if (browserPageIsVisible()) run(); }, delayMs);
  };
  page?.addEventListener("visibilitychange", resume);
  return {
    start() { if (!armed) { armed = true; resume(); } },
    clear() { armed = false; cancel(); },
    dispose() { armed = false; cancel(); page?.removeEventListener("visibilitychange", resume); },
  };
}

/** Hidden pages retain stale cache state without starting background network
 * work. React Query's focus reconciliation refetches the active query when the
 * page becomes visible again. */
export function invalidateForBrowserPage(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  queryKey: readonly unknown[],
  visible = browserPageIsVisible(),
): void {
  void queryClient.invalidateQueries({
    queryKey,
    ...(visible ? {} : { refetchType: "none" as const }),
  });
}
