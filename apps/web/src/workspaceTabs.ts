import type { Route } from "./routing";

export type WorkspaceTabRoute = Route;

export interface WorkspaceTabState {
  /** Tab-instance identity. It is intentionally independent from the route. */
  key: string;
  route: WorkspaceTabRoute;
  lastActivatedAt: number;
  title?: string;
}

export interface WorkspaceTabSession {
  tabs: WorkspaceTabState[];
  activeKey?: string;
}

interface PersistedWorkspaceTabs {
  version: 2;
  tabs: WorkspaceTabState[];
  activeKey?: string;
}

export const WORKSPACE_TABS_STORAGE_KEY = "ponderosa.workspaceTabs.v2";

export function isWorkspaceTabRoute(route: unknown): route is WorkspaceTabRoute {
  if (!route || typeof route !== "object") return false;
  const candidate = route as Record<string, unknown>;
  if (candidate.kind === "home" || candidate.kind === "projects" || candidate.kind === "allChat" || candidate.kind === "allAgents") return true;
  if (typeof candidate.projectId !== "string" || !candidate.projectId) return false;
  if (candidate.kind === "project" || candidate.kind === "agents") return true;
  if (candidate.kind === "conversation") return typeof candidate.conversationId === "string" && Boolean(candidate.conversationId);
  if (candidate.kind === "agent") return typeof candidate.agentId === "string" && Boolean(candidate.agentId);
  if (candidate.kind === "review") return typeof candidate.agentId === "string" && Boolean(candidate.agentId)
    && (candidate.path === undefined || typeof candidate.path === "string");
  return false;
}

/** Stable resource identity, used only when a deleted resource must be removed. */
export function workspaceTabKey(route: Route): string {
  switch (route.kind) {
    case "home": return "home";
    case "projects": return "projects";
    case "allChat": return "all-chat";
    case "allAgents": return "all-agents";
    case "project": return `project:${route.projectId}`;
    case "conversation": return `conversation:${route.projectId}:${route.conversationId}`;
    case "agents": return `agents:${route.projectId}`;
    case "agent": return `agent:${route.projectId}:${route.agentId}`;
    case "review": return `review:${route.projectId}:${route.agentId}:${route.path ?? "all"}`;
  }
}

function generatedTabKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `tab:${crypto.randomUUID()}`
    : `tab:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function createWorkspaceTab(route: Route, now = Date.now(), key = generatedTabKey()): WorkspaceTabState {
  return { key, route, lastActivatedAt: now };
}

/** Explicitly create a new browser-style tab. Duplicate routes are valid. */
export function openWorkspaceTab(
  current: WorkspaceTabState[],
  route: Route,
  now = Date.now(),
  key = generatedTabKey(),
): WorkspaceTabState[] {
  return [...current, createWorkspaceTab(route, now, key)];
}

/** Navigation replaces the active tab's location; it never creates a tab. */
export function navigateWorkspaceTab(
  current: WorkspaceTabState[],
  key: string,
  route: Route,
  now = Date.now(),
): WorkspaceTabState[] {
  const activatedAt = Math.max(now, ...current.map((tab) => tab.lastActivatedAt + 1), 0);
  return current.map((tab) => tab.key === key ? { ...tab, route, lastActivatedAt: activatedAt } : tab);
}

export function renameWorkspaceTab(current: WorkspaceTabState[], key: string, title: string): WorkspaceTabState[] {
  const normalized = title.trim().slice(0, 80);
  return current.map((tab) => tab.key === key
    ? { ...tab, ...(normalized ? { title: normalized } : { title: undefined }) }
    : tab);
}

export function closeWorkspaceTab(current: WorkspaceTabState[], key: string): WorkspaceTabState[] {
  return current.length <= 1 ? current : current.filter((tab) => tab.key !== key);
}

export function adjacentWorkspaceTab(current: WorkspaceTabState[], key: string): WorkspaceTabState | undefined {
  const index = current.findIndex((tab) => tab.key === key);
  if (index < 0) return undefined;
  return current[index + 1] ?? current[index - 1];
}

/** Move one open workspace tab to another tab's position without changing either tab's identity. */
export function reorderWorkspaceTabs(
  current: WorkspaceTabState[],
  draggedKey: string,
  targetKey: string,
): WorkspaceTabState[] {
  if (draggedKey === targetKey) return current;
  const draggedIndex = current.findIndex((tab) => tab.key === draggedKey);
  const targetIndex = current.findIndex((tab) => tab.key === targetKey);
  if (draggedIndex < 0 || targetIndex < 0) return current;
  const next = [...current];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged!);
  return next;
}

export function mostRecentWorkspaceTab(current: WorkspaceTabState[], excludingKey?: string): WorkspaceTabState | undefined {
  return current
    .filter((tab) => tab.key !== excludingKey)
    .reduce<WorkspaceTabState | undefined>((latest, tab) => !latest || tab.lastActivatedAt > latest.lastActivatedAt ? tab : latest, undefined);
}

export function removeWorkspaceRoute(current: WorkspaceTabState[], route: Route): WorkspaceTabState[] {
  const resourceKey = workspaceTabKey(route);
  const retained = current.filter((tab) => workspaceTabKey(tab.route) !== resourceKey);
  return retained.length > 0 ? retained : [createWorkspaceTab({ kind: "home" })];
}

export function removeProjectWorkspaceTabs(current: WorkspaceTabState[], projectIds: Set<string>): WorkspaceTabState[] {
  const retained = current.filter((tab) => !("projectId" in tab.route) || projectIds.has(tab.route.projectId));
  return retained.length > 0 ? retained : [createWorkspaceTab({ kind: "home" })];
}

export function serializeWorkspaceTabs(tabs: WorkspaceTabState[], activeKey?: string): string {
  return JSON.stringify({ version: 2, tabs, ...(activeKey ? { activeKey } : {}) } satisfies PersistedWorkspaceTabs);
}

export function restoreWorkspaceTabSession(value: string | null): WorkspaceTabSession {
  if (!value) return { tabs: [] };
  try {
    const parsed = JSON.parse(value) as Partial<PersistedWorkspaceTabs>;
    if (parsed.version !== 2 || !Array.isArray(parsed.tabs)) return { tabs: [] };
    const seen = new Set<string>();
    const tabs = parsed.tabs.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || !isWorkspaceTabRoute(candidate.route) ||
          typeof candidate.key !== "string" || !candidate.key || seen.has(candidate.key) ||
          !Number.isFinite(candidate.lastActivatedAt) ||
          (candidate.title !== undefined && typeof candidate.title !== "string")) return [];
      seen.add(candidate.key);
      return [{
        key: candidate.key,
        route: candidate.route,
        lastActivatedAt: candidate.lastActivatedAt,
        ...(candidate.title?.trim() ? { title: candidate.title.trim().slice(0, 80) } : {}),
      }];
    });
    return { tabs, ...(parsed.activeKey && seen.has(parsed.activeKey) ? { activeKey: parsed.activeKey } : {}) };
  } catch {
    return { tabs: [] };
  }
}

export function restoreWorkspaceTabs(value: string | null): WorkspaceTabState[] {
  return restoreWorkspaceTabSession(value).tabs;
}
