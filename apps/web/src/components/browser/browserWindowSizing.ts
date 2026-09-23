export const MIN_PRIMARY_WORKSPACE_WIDTH = 640;
export const WORKSPACE_SHELL_RESERVE = 400;
export const MIN_BROWSER_DOCK_WIDTH = 360;
export const PREFERRED_BROWSER_DOCK_WIDTH = 720;

export function maximumBrowserDockWidth(viewportWidth: number): number {
  return Math.max(
    0,
    Math.floor(viewportWidth - WORKSPACE_SHELL_RESERVE - MIN_PRIMARY_WORKSPACE_WIDTH),
  );
}

export function browserDockIsAvailable(viewportWidth: number): boolean {
  return maximumBrowserDockWidth(viewportWidth) >= MIN_BROWSER_DOCK_WIDTH;
}

export function clampBrowserDockWidth(requested: number, viewportWidth: number): number {
  const maximum = maximumBrowserDockWidth(viewportWidth);
  if (maximum < MIN_BROWSER_DOCK_WIDTH) return 0;
  return Math.min(maximum, Math.max(MIN_BROWSER_DOCK_WIDTH, requested));
}
