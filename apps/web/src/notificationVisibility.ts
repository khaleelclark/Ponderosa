export function notificationVisibilityThreshold(
  elementHeight: number,
  availableHeight: number,
  elementWidth: number,
  availableWidth: number,
): number {
  if (elementHeight <= 0 || availableHeight <= 0 || elementWidth <= 0 || availableWidth <= 0) return 0.25;
  const vertical = Math.min(0.5, (Math.min(elementHeight, availableHeight) * 0.5) / elementHeight);
  const horizontal = Math.min(0.5, (Math.min(elementWidth, availableWidth) * 0.5) / elementWidth);
  return vertical * horizontal;
}

export function notificationIsSufficientlyVisible(
  entry: Pick<
    IntersectionObserverEntry,
    "isIntersecting" | "boundingClientRect" | "intersectionRect" | "rootBounds"
  >,
): boolean {
  if (!entry.isIntersecting) return false;
  const availableHeight = entry.rootBounds?.height ?? window.innerHeight;
  const availableWidth = entry.rootBounds?.width ?? window.innerWidth;
  if (entry.boundingClientRect.height <= 0 || availableHeight <= 0 ||
      entry.boundingClientRect.width <= 0 || availableWidth <= 0) return false;
  return entry.intersectionRect.height >=
      Math.min(entry.boundingClientRect.height, availableHeight) * 0.5 &&
    entry.intersectionRect.width >=
      Math.min(entry.boundingClientRect.width, availableWidth) * 0.5;
}

export function observeNotificationVisibility(
  element: Element,
  onVisible: (visible: boolean) => void,
  scrollRoot: Element | null = element.closest(".chat-scroll-region"),
): () => void {
  let observer: IntersectionObserver | undefined;
  let threshold: number | undefined;
  let intersecting = false;
  const observe = () => {
    const elementRect = element.getBoundingClientRect();
    const rootRect = scrollRoot?.getBoundingClientRect();
    const nextThreshold = notificationVisibilityThreshold(
      elementRect.height,
      rootRect?.height ??
        document.documentElement.clientHeight ?? window.innerHeight,
      elementRect.width,
      rootRect?.width ??
        document.documentElement.clientWidth ?? window.innerWidth,
    );
    if (observer && threshold === nextThreshold) return;
    observer?.disconnect();
    threshold = nextThreshold;
    observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      intersecting = Boolean(entry?.isIntersecting);
      onVisible(Boolean(entry && notificationIsSufficientlyVisible(entry)));
    }, { root: scrollRoot, threshold: nextThreshold });
    observer.observe(element);
  };
  observe();
  // Area ratios cannot detect every half-height/half-width transition. Re-arm
  // intersecting messages once per scrolling frame for exact clipping checks.
  // Native observation still detects offscreen messages entering the viewport.
  let frame: number | undefined;
  const recheck = () => {
    if (!intersecting || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      observer?.unobserve(element);
      observer?.observe(element);
    });
  };
  document.addEventListener("scroll", recheck, true);
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(observe);
  resizeObserver?.observe(element);
  if (scrollRoot && scrollRoot !== element) resizeObserver?.observe(scrollRoot);
  window.addEventListener("resize", observe);
  return () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    document.removeEventListener("scroll", recheck, true);
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
