import { useLayoutEffect } from "react";

export const APP_VIEWPORT_BLOCK_SIZE = "--ponderosa-app-viewport-block-size";
export const APP_VIEWPORT_BLOCK_OFFSET =
  "--ponderosa-app-viewport-block-offset";

interface AppViewportMetrics {
  innerHeight: number;
  visualViewport?: Pick<VisualViewport, "height" | "offsetTop" | "scale">;
}

/**
 * Return the visible viewport height. Mobile browsers can pan a smaller visual
 * viewport over the layout viewport when the keyboard opens, so height and
 * offset must remain separate layout inputs.
 */
export function appViewportBlockSize({
  innerHeight,
  visualViewport,
}: AppViewportMetrics): number {
  const layoutHeight = Math.max(1, Math.round(innerHeight));
  if (!visualViewport || visualViewport.scale !== 1) return layoutHeight;
  return Math.max(
    1,
    Math.min(layoutHeight, Math.round(visualViewport.height)),
  );
}

/**
 * Return the visual viewport's position in layout coordinates. This keeps the
 * application inside the keyboard-safe region when iOS pans the viewport.
 */
export function appViewportBlockOffset({
  visualViewport,
}: AppViewportMetrics): number {
  if (!visualViewport || visualViewport.scale !== 1) return 0;
  return Math.max(0, Math.round(visualViewport.offsetTop));
}

/**
 * Own the application viewport geometry in one place. CSS dynamic viewport
 * units remain the no-JavaScript fallback; VisualViewport closes the remaining
 * keyboard and browser-chrome gaps without introducing a second fixed/sticky
 * chat surface.
 */
export function useAppViewport(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      const metrics: AppViewportMetrics = {
        innerHeight: window.innerHeight,
        ...(viewport ? { visualViewport: viewport } : {}),
      };
      root.style.setProperty(
        APP_VIEWPORT_BLOCK_SIZE,
        `${appViewportBlockSize(metrics)}px`,
      );
      root.style.setProperty(
        APP_VIEWPORT_BLOCK_OFFSET,
        `${appViewportBlockOffset(metrics)}px`,
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
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
      root.style.removeProperty(APP_VIEWPORT_BLOCK_OFFSET);
    };
  }, []);
}
