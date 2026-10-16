import type { QueryClient } from "@tanstack/react-query";

export function browserPageIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
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
