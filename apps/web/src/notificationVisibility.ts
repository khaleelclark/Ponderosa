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
  scrollRoot: Element | null = element.closest(".chat-scroll-region"),
): () => void {
  let observer: IntersectionObserver | undefined;
  let threshold: number | undefined;
  const observe = () => {
    const nextThreshold = notificationVisibilityThreshold(
      element.getBoundingClientRect().height,
      scrollRoot?.getBoundingClientRect().height ??
        document.documentElement.clientHeight ?? window.innerHeight,
    );
    if (observer && threshold === nextThreshold) return;
    observer?.disconnect();
    threshold = nextThreshold;
    observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      onVisible(Boolean(entry && notificationIsSufficientlyVisible(entry)));
    }, { root: scrollRoot, threshold: nextThreshold });
    observer.observe(element);
  };
  observe();
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(observe);
  resizeObserver?.observe(element);
  if (scrollRoot && scrollRoot !== element) resizeObserver?.observe(scrollRoot);
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
  inFlightIds: ReadonlySet<string> = new Set(),
  deferredRequeueIds: Set<string> = new Set(),
): void {
  for (const id of visibleIds) {
    if (completedIds.has(id)) continue;
    retryAttempts.delete(id);
    if (inFlightIds.has(id)) deferredRequeueIds.add(id);
    else pendingIds.add(id);
  }
}

export function requeueFailedVisibleNotificationRead(
  id: string,
  mounted: boolean,
  visibleIds: ReadonlySet<string>,
  pendingIds: Set<string>,
  retryAttempts: Map<string, number>,
  deferredRequeueIds: Set<string>,
): number | undefined {
  const deferred = deferredRequeueIds.delete(id);
  if (!mounted || !visibleIds.has(id)) return undefined;
  if (deferred) retryAttempts.delete(id);
  const attempt = retryAttempts.get(id) ?? 0;
  if (attempt >= 3) return undefined;
  const nextAttempt = attempt + 1;
  retryAttempts.set(id, nextAttempt);
  pendingIds.add(id);
  return 250 * nextAttempt;
}
