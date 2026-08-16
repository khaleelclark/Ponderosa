import { useLayoutEffect } from "react";

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
 * browser-chrome gaps without introducing a second fixed/sticky chat surface.
 */
export function useAppViewport(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      root.style.setProperty(
        APP_VIEWPORT_BLOCK_SIZE,
        `${appViewportBlockSize({
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
    };
  }, []);
}
