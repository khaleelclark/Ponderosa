export const COMPACT_VIEWPORT_MAX_HEIGHT = 600;
export const MOBILE_VIEWPORT_MAX_WIDTH = 600;

/** Compact controls when horizontal room is phone-sized or vertical room is scarce. */
export function isCompactViewport({ width, height }: { width: number; height: number }): boolean {
  return width < MOBILE_VIEWPORT_MAX_WIDTH || height <= COMPACT_VIEWPORT_MAX_HEIGHT;
}

export function compactViewportQuery(mobileQuery: string): string {
  return `${mobileQuery}, (max-height: ${COMPACT_VIEWPORT_MAX_HEIGHT}px)`;
}
