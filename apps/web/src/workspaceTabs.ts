import { isAgentDetailView, type Route } from "./routing";
import { createClientId } from "./clientId";
import { isRouteKind, workspaceTabKey } from "./routeRegistry";

type WorkspaceTabRoute = Route;

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

/**
 * Reconciles persisted browser-style tabs with the URL that opened Ponderosa.
 * The app root is the neutral Home overview, so it must activate a real Home tab
 * instead of relabeling whichever persisted tab happened to be active.
 * Explicit deep links continue to open the requested destination.
 */
export function initializeWorkspaceTabSession(
  restored: WorkspaceTabSession,
  initialRoute: Route,
  now = Date.now(),
): Required<WorkspaceTabSession> {
  const routeKey = workspaceTabKey(initialRoute);
  const existing = restored.tabs.find((tab) => workspaceTabKey(tab.route) === routeKey);
  if (existing) {
    return {
      tabs: restored.tabs.map((tab) => tab.key === existing.key
        ? { ...tab, route: initialRoute, lastActivatedAt: now }
        : tab),
      activeKey: existing.key,
    };
  }
  if (restored.tabs.length > 0) {
    const activeKey = restored.activeKey ?? restored.tabs[0]!.key;
    const reusable = reusableWorkspaceTab(restored.tabs, activeKey, initialRoute);
    if (reusable?.key === activeKey) {
      return {
        tabs: navigateWorkspaceTab(restored.tabs, activeKey, initialRoute, now),
        activeKey,
      };
    }
  }
  const linked = createWorkspaceTab(initialRoute, now);
  return { tabs: [linked, ...restored.tabs], activeKey: linked.key };
}

interface PersistedWorkspaceTabs {
  version: 2;
  tabs: WorkspaceTabState[];
  activeKey?: string;
}

export const WORKSPACE_TABS_STORAGE_KEY = "ponderosa.workspaceTabs.v2";

function isWorkspaceTabRoute(route: unknown): route is WorkspaceTabRoute {
  if (!route || typeof route !== "object") return false;
  const candidate = route as Record<string, unknown>;
  if (!isRouteKind(candidate.kind)) return false;
  const kind = candidate.kind;
  switch (kind) {
    case "home":
    case "projects":
    case "allChat":
    case "allTriggers":
    case "profile":
      return true;
    case "allChats":
    case "allAgents":
      return candidate.filterProjectId === undefined ||
        typeof candidate.filterProjectId === "string";
    case "settings":
      return candidate.section === undefined ||
        ["general", "providers", "notifications"].includes(
          String(candidate.section),
        );
    case "usage":
      return candidate.projectId === undefined ||
        typeof candidate.projectId === "string";
    case "wiki":
      return candidate.articleId === undefined ||
        typeof candidate.articleId === "string";
    case "project":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId);
    case "workspaceFile":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        typeof candidate.path === "string" &&
        Boolean(candidate.path);
    case "agents":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        (candidate.create === undefined ||
          typeof candidate.create === "boolean") &&
        (candidate.managerAgentId === undefined ||
          typeof candidate.managerAgentId === "string") &&
        (candidate.continueToTrigger === undefined ||
          typeof candidate.continueToTrigger === "boolean");
    case "projectWork":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        (candidate.conversationId === undefined ||
          typeof candidate.conversationId === "string") &&
        (candidate.focusId === undefined ||
          typeof candidate.focusId === "string");
    case "browser":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        ((candidate.agentId === undefined && candidate.runId === undefined) ||
          (typeof candidate.agentId === "string" &&
            Boolean(candidate.agentId) &&
            typeof candidate.runId === "string" &&
            Boolean(candidate.runId)));
    case "conversation":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        typeof candidate.conversationId === "string" &&
        Boolean(candidate.conversationId);
    case "agent":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        typeof candidate.agentId === "string" &&
        Boolean(candidate.agentId) &&
        (candidate.view === undefined || isAgentDetailView(candidate.view)) &&
        (candidate.createTrigger === undefined ||
          typeof candidate.createTrigger === "boolean");
    case "review":
      return typeof candidate.projectId === "string" &&
        Boolean(candidate.projectId) &&
        typeof candidate.agentId === "string" &&
        Boolean(candidate.agentId) &&
        (candidate.path === undefined || typeof candidate.path === "string");
  }
  const unhandled: never = kind;
  return unhandled;
}

function generatedTabKey(): string {
  return createClientId("tab:", () => `${Date.now()}:${Math.random().toString(36).slice(2)}`);
}

export function createWorkspaceTab(route: Route, now = Date.now(), key = generatedTabKey()): WorkspaceTabState {
  return { key, route, lastActivatedAt: now };
}

/** Prefer the active matching resource, then the most recently used matching tab. */
export function reusableWorkspaceTab(current: WorkspaceTabState[], activeKey: string, route: Route): WorkspaceTabState | undefined {
  const resourceKey = workspaceTabKey(route);
  const matches = current.filter((tab) => workspaceTabKey(tab.route) === resourceKey);
  return matches.find((tab) => tab.key === activeKey) ?? matches.sort((a, b) => b.lastActivatedAt - a.lastActivatedAt)[0];
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

/** Desktop resource menus create a tab without stealing focus from current work. */
export function openWorkspaceTabInBackground(
  current: WorkspaceTabState[],
  route: Route,
  now = Date.now(),
  key = generatedTabKey(),
): WorkspaceTabState[] {
  return openWorkspaceTab(current, route, now, key);
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

export function removeWorkspaceRoute(current: WorkspaceTabState[], route: Route): WorkspaceTabState[] {
  const resourceKey = workspaceTabKey(route);
  const retained = current.filter((tab) => workspaceTabKey(tab.route) !== resourceKey);
  return retained.length > 0 ? retained : [createWorkspaceTab({ kind: "home" })];
}

export function removeProjectWorkspaceTabs(current: WorkspaceTabState[], projectIds: Set<string>): WorkspaceTabState[] {
  const retained = current.filter((tab) => !("projectId" in tab.route) || typeof tab.route.projectId !== "string" || projectIds.has(tab.route.projectId));
  return retained.length > 0 ? retained : [createWorkspaceTab({ kind: "home" })];
}

export function serializeWorkspaceTabs(tabs: WorkspaceTabState[], activeKey?: string): string {
  // URL provenance controls only the first render of an externally opened
  // chat. Persisting it would turn later in-app tab restores into deep links.
  const persistentTabs = tabs.map((tab) => {
    if (tab.route.kind !== "conversation" || !tab.route.urlDriven) return tab;
    const { urlDriven: _urlDriven, ...route } = tab.route;
    return { ...tab, route };
  });
  return JSON.stringify({ version: 2, tabs: persistentTabs, ...(activeKey ? { activeKey } : {}) } satisfies PersistedWorkspaceTabs);
}

export function restoreWorkspaceTabSession(value: string | null): WorkspaceTabSession {
  if (!value) return { tabs: [] };
  try {
    const parsed = JSON.parse(value) as Partial<PersistedWorkspaceTabs>;
    if (parsed.version !== 2 || !Array.isArray(parsed.tabs)) return { tabs: [] };
    const seen = new Set<string>();
    const tabs = parsed.tabs.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const route = candidate.route;
      if (!isWorkspaceTabRoute(route) ||
          typeof candidate.key !== "string" || !candidate.key || seen.has(candidate.key) ||
          !Number.isFinite(candidate.lastActivatedAt) ||
          (candidate.title !== undefined && typeof candidate.title !== "string")) return [];
      seen.add(candidate.key);
      return [{
        key: candidate.key,
        route,
        lastActivatedAt: candidate.lastActivatedAt,
        ...(candidate.title?.trim() ? { title: candidate.title.trim().slice(0, 80) } : {}),
      }];
    });
    return { tabs, ...(parsed.activeKey && seen.has(parsed.activeKey) ? { activeKey: parsed.activeKey } : {}) };
  } catch {
    return { tabs: [] };
  }
}
