import type { Route } from "./routing";

export type WorkspaceTabRoute = Extract<Route,
  | { kind: "project" }
  | { kind: "conversation" }
  | { kind: "agents" }
  | { kind: "agent" }
>;

export interface WorkspaceTabState {
  key: string;
  route: WorkspaceTabRoute;
  lastActivatedAt: number;
}

interface PersistedWorkspaceTabs {
  version: 1;
  tabs: WorkspaceTabState[];
}

export const WORKSPACE_TABS_STORAGE_KEY = "ponderosa.workspaceTabs.v1";

export function isWorkspaceTabRoute(route: unknown): route is WorkspaceTabRoute {
  if (!route || typeof route !== "object") return false;
  const candidate = route as Record<string, unknown>;
  if (typeof candidate.projectId !== "string" || !candidate.projectId) return false;
  if (candidate.kind === "project" || candidate.kind === "agents") return true;
  if (candidate.kind === "conversation") return typeof candidate.conversationId === "string" && Boolean(candidate.conversationId);
  if (candidate.kind === "agent") return typeof candidate.agentId === "string" && Boolean(candidate.agentId);
  return false;
}

export function workspaceTabKey(route: Route): string | undefined {
  switch (route.kind) {
    case "project": return `project:${route.projectId}`;
    case "conversation": return `conversation:${route.projectId}:${route.conversationId}`;
    case "agents": return `agents:${route.projectId}`;
    case "agent": return `agent:${route.projectId}:${route.agentId}`;
    default: return undefined;
  }
}

export function openWorkspaceTab(current: WorkspaceTabState[], route: Route, now = Date.now()): WorkspaceTabState[] {
  if (!isWorkspaceTabRoute(route)) return current;
  const key = workspaceTabKey(route)!;
  const activatedAt = Math.max(now, ...current.map((tab) => tab.lastActivatedAt + 1), 0);
  const existingIndex = current.findIndex((tab) => tab.key === key);
  if (existingIndex < 0) return [...current, { key, route, lastActivatedAt: activatedAt }];
  return current.map((tab, index) => index === existingIndex ? { ...tab, route, lastActivatedAt: activatedAt } : tab);
}

export function closeWorkspaceTab(current: WorkspaceTabState[], key: string): WorkspaceTabState[] {
  return current.filter((tab) => tab.key !== key);
}

export function mostRecentWorkspaceTab(current: WorkspaceTabState[], excludingKey?: string): WorkspaceTabState | undefined {
  return current
    .filter((tab) => tab.key !== excludingKey)
    .reduce<WorkspaceTabState | undefined>((latest, tab) => !latest || tab.lastActivatedAt > latest.lastActivatedAt ? tab : latest, undefined);
}

export function removeWorkspaceRoute(current: WorkspaceTabState[], route: Route): WorkspaceTabState[] {
  const key = workspaceTabKey(route);
  return key ? closeWorkspaceTab(current, key) : current;
}

export function removeProjectWorkspaceTabs(current: WorkspaceTabState[], projectIds: Set<string>): WorkspaceTabState[] {
  return current.filter((tab) => projectIds.has(tab.route.projectId));
}

export function serializeWorkspaceTabs(tabs: WorkspaceTabState[]): string {
  return JSON.stringify({ version: 1, tabs } satisfies PersistedWorkspaceTabs);
}

export function restoreWorkspaceTabs(value: string | null): WorkspaceTabState[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Partial<PersistedWorkspaceTabs>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return [];
    const seen = new Set<string>();
    return parsed.tabs.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || !isWorkspaceTabRoute(candidate.route)) return [];
      const key = workspaceTabKey(candidate.route);
      if (!key || candidate.key !== key || seen.has(key) || !Number.isFinite(candidate.lastActivatedAt)) return [];
      seen.add(key);
      return [{ key, route: candidate.route, lastActivatedAt: candidate.lastActivatedAt }];
    });
  } catch {
    return [];
  }
}
