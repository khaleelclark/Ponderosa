import { useEffect, useRef } from "react";

export function useInfiniteScrollSentinel({
  enabled,
  loading,
  onLoadMore,
  rootMargin = "240px 0px",
}: {
  enabled: boolean;
  loading: boolean;
  onLoadMore(): void | Promise<unknown>;
  rootMargin?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || loading || !sentinel) return;
    const root = sentinel.closest<HTMLElement>(".ponderosa-scroll");
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0];
        if (
          !entry?.isIntersecting ||
          document.visibilityState !== "visible" ||
          !sentinel.isConnected ||
          sentinel.getClientRects().length === 0
        ) return;
        void onLoadMoreRef.current();
      },
      { root, rootMargin, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, loading, rootMargin]);

  return sentinelRef;
}
