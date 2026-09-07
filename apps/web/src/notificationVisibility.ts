export function notificationVisibilityThreshold(
  elementHeight: number,
  availableHeight: number,
): number {
  if (elementHeight <= 0 || availableHeight <= 0) return 0.5;
  return Math.min(0.5, (Math.min(elementHeight, availableHeight) * 0.5) / elementHeight);
}

export function notificationIsSufficientlyVisible(
  entry: Pick<
    IntersectionObserverEntry,
    "isIntersecting" | "boundingClientRect" | "intersectionRect" | "rootBounds"
  >,
): boolean {
  if (!entry.isIntersecting) return false;
  const availableHeight = entry.rootBounds?.height ?? window.innerHeight;
  if (entry.boundingClientRect.height <= 0 || availableHeight <= 0) return false;
  return entry.intersectionRect.height >=
    Math.min(entry.boundingClientRect.height, availableHeight) * 0.5;
}

export function observeNotificationVisibility(
  element: Element,
  onVisible: (visible: boolean) => void,
): () => void {
  let observer: IntersectionObserver | undefined;
  let threshold: number | undefined;
  const observe = () => {
    const nextThreshold = notificationVisibilityThreshold(
      element.getBoundingClientRect().height,
      document.documentElement.clientHeight || window.innerHeight,
    );
    if (observer && threshold === nextThreshold) return;
    observer?.disconnect();
    threshold = nextThreshold;
    observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      onVisible(Boolean(entry && notificationIsSufficientlyVisible(entry)));
    }, { threshold: nextThreshold });
    observer.observe(element);
  };
  observe();
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(observe);
  resizeObserver?.observe(element);
  window.addEventListener("resize", observe);
  return () => {
    observer?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", observe);
  };
}

export function requeueVisibleNotificationReads(
  visibleIds: ReadonlySet<string>,
  completedIds: ReadonlySet<string>,
  pendingIds: Set<string>,
  retryAttempts: Map<string, number>,
): void {
  for (const id of visibleIds) {
    if (completedIds.has(id)) continue;
    retryAttempts.delete(id);
    pendingIds.add(id);
  }
}
