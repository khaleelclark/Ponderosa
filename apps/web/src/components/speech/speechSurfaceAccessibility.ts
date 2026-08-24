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
  const listeners: Array<{
    target: Document | Window;
    type: string;
    listener: EventListener;
  }> = [];

  const cleanup = () => {
    if (!active) return;
    active = false;
    try {
      observer?.disconnect();
    } catch {
      // Continue releasing every resource if a browser shim rejects cleanup.
    }
    try {
      resizeObserver?.disconnect();
    } catch {
      // Continue releasing every resource if a browser shim rejects cleanup.
    }
    if (fallbackInterval !== undefined) {
      try {
        window.clearInterval(fallbackInterval);
      } catch {
        // Continue releasing listeners if a browser shim rejects cleanup.
      }
    }
    for (const { target, type, listener } of listeners) {
      try {
        target.removeEventListener(type, listener);
      } catch {
        // Best-effort cleanup must not prevent the remaining removals.
      }
    }
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
  const addListener = (
    target: Document | Window,
    type: string,
    listener: EventListener,
  ) => {
    const registration = { target, type, listener };
    listeners.push(registration);
    target.addEventListener(type, listener);
  };

  try {
    const hasMutationObserver = typeof MutationObserver !== "undefined";
    const hasResizeObserver = typeof ResizeObserver !== "undefined";

    if (hasMutationObserver) {
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: SURFACE_ATTRIBUTE_FILTER,
        childList: true,
        subtree: true,
      });
    }
    if (hasResizeObserver) {
      resizeObserver = new ResizeObserver(check);
      const surface = element();
      if (surface) resizeObserver.observe(surface);
    }
    if (!hasMutationObserver || !hasResizeObserver) {
      fallbackInterval = window.setInterval(check, 200);
    }
    addListener(document, "visibilitychange", check);
    addListener(window, "hashchange", check);
    addListener(window, "pagehide", handlePageHide);
    addListener(window, "popstate", check);
    addListener(window, "resize", check);
    check();
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
