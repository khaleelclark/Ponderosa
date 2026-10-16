import { useLayoutEffect } from "react";
import { isIOSDevice } from "../browserPlatform";

export const APP_VIEWPORT_BLOCK_SIZE = "--ponderosa-app-viewport-block-size";

interface AppViewportMetrics {
  innerHeight: number;
  visualViewport?: Pick<VisualViewport, "height" | "offsetTop" | "scale">;
}

/**
 * Return the visible viewport's lower edge in layout coordinates. Mobile
 * browsers either resize the layout viewport for the keyboard or pan a smaller
 * visual viewport over it; offsetTop + height handles both models.
 */
export function appViewportBlockSize({
  innerHeight,
  visualViewport,
}: AppViewportMetrics): number {
  const layoutHeight = Math.max(1, Math.round(innerHeight));
  if (!visualViewport || visualViewport.scale !== 1) return layoutHeight;
  const visualBottom = Math.round(
    visualViewport.offsetTop + visualViewport.height,
  );
  return Math.max(1, Math.min(layoutHeight, visualBottom));
}

/**
 * Own the application height in one place. CSS dynamic viewport units remain
 * the no-JavaScript fallback; VisualViewport closes the remaining keyboard and
 * browser-chrome gaps. On iOS the root frame follows the visual viewport's
 * origin and height separately; adding the pan offset to its height would put
 * its bottom below the visible region. Other platforms keep their layout.
 */
export function useAppViewport(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const ios = isIOSDevice();
    if (ios) root.dataset.iosViewport = "true";
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      // Keep the unzoomed frame during pinch zoom; do not fight native panning.
      if (ios && viewport && viewport.scale !== 1) return;
      if (ios && viewport) {
        root.style.setProperty("--ponderosa-app-viewport-top", `${viewport.offsetTop}px`);
      }
      root.style.setProperty(
        APP_VIEWPORT_BLOCK_SIZE,
        `${ios && viewport ? Math.max(1, viewport.height) : appViewportBlockSize({
          innerHeight: window.innerHeight,
          ...(viewport ? { visualViewport: viewport } : {}),
        })}px`,
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };

    update();
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("orientationchange", scheduleUpdate);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("orientationchange", scheduleUpdate);
      root.style.removeProperty(APP_VIEWPORT_BLOCK_SIZE);
      root.style.removeProperty("--ponderosa-app-viewport-top");
      delete root.dataset.iosViewport;
    };
  }, []);
}
