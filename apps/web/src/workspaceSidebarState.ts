export const WORKSPACE_SIDEBAR_STORAGE_KEY = "ponderosa.workspaceSidebar.v1";
export const WORKSPACE_SIDEBAR_MIN_WIDTH = 320;
export const WORKSPACE_SIDEBAR_MAX_WIDTH = 520;
export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH = 390;

export interface WorkspaceSidebarState {
  collapsed: boolean;
  width: number;
}

export function clampWorkspaceSidebarWidth(width: number): number {
  return Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH, Math.min(WORKSPACE_SIDEBAR_MAX_WIDTH, Math.round(width)));
}

export function restoreWorkspaceSidebarState(value: string | null): WorkspaceSidebarState {
  if (!value) return { collapsed: false, width: WORKSPACE_SIDEBAR_DEFAULT_WIDTH };
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceSidebarState>;
    return {
      collapsed: parsed.collapsed === true,
      width: clampWorkspaceSidebarWidth(typeof parsed.width === "number" ? parsed.width : WORKSPACE_SIDEBAR_DEFAULT_WIDTH),
    };
  } catch {
    return { collapsed: false, width: WORKSPACE_SIDEBAR_DEFAULT_WIDTH };
  }
}

export function serializeWorkspaceSidebarState(state: WorkspaceSidebarState): string {
  return JSON.stringify({ collapsed: state.collapsed, width: clampWorkspaceSidebarWidth(state.width) });
}
