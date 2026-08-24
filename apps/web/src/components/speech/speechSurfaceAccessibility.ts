const SURFACE_ATTRIBUTE_FILTER = [
  "aria-hidden",
  "class",
  "hidden",
  "inert",
  "style",
];

function elementIsHidden(element: HTMLElement): boolean {
  if (
    element.hidden ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    (element as HTMLElement & { inert?: boolean }).inert === true ||
    element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
  ) {
    return true;
  }
  const style = window.getComputedStyle(element);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse"
  );
}

export function speechSurfaceIsAccessible(
  element: HTMLElement | null,
): boolean {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !element ||
    !element.isConnected ||
    document.visibilityState !== "visible"
  ) {
    return false;
  }
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    if (elementIsHidden(ancestor)) return false;
    ancestor = ancestor.parentElement;
  }
  return Array.from(element.getClientRects()).some(
    rect => rect.width > 0 && rect.height > 0,
  );
}

export function monitorSpeechSurfaceAccessibility(
  element: () => HTMLElement | null,
  onInactive: () => void,
): () => void {
  let active = true;
  let observer: MutationObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let fallbackInterval: number | undefined;

  const cleanup = () => {
    if (!active) return;
    active = false;
    observer?.disconnect();
    resizeObserver?.disconnect();
    if (fallbackInterval !== undefined) {
      window.clearInterval(fallbackInterval);
    }
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("hashchange", check);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", check);
    window.removeEventListener("resize", check);
  };
  const handleInactive = () => {
    if (!active) return;
    cleanup();
    onInactive();
  };
  const check = () => {
    if (active && !speechSurfaceIsAccessible(element())) handleInactive();
  };
  const handlePageHide = () => handleInactive();

  if (typeof MutationObserver === "undefined") {
    fallbackInterval = window.setInterval(check, 200);
  } else {
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: SURFACE_ATTRIBUTE_FILTER,
      childList: true,
      subtree: true,
    });
  }
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(check);
    const surface = element();
    if (surface) resizeObserver.observe(surface);
  }
  document.addEventListener("visibilitychange", check);
  window.addEventListener("hashchange", check);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", check);
  window.addEventListener("resize", check);
  check();
  return cleanup;
}
