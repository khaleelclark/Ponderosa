import { isAgentDetailView, type Route } from "./routing";

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
  if (initialRoute.kind === "home") {
    const existingHome = restored.tabs.find((tab) => tab.route.kind === "home");
    if (existingHome) return { tabs: restored.tabs, activeKey: existingHome.key };
    const home = createWorkspaceTab({ kind: "home" }, now);
    return { tabs: [home, ...restored.tabs], activeKey: home.key };
  }
  if (restored.tabs.length > 0) {
    return { tabs: restored.tabs, activeKey: restored.activeKey ?? restored.tabs[0]!.key };
  }
  const first = createWorkspaceTab(initialRoute, now);
  return { tabs: [first], activeKey: first.key };
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
  if (candidate.kind === "home" || candidate.kind === "projects" || candidate.kind === "allChat" || candidate.kind === "allTriggers" || candidate.kind === "profile") return true;
  if (candidate.kind === "allChats") return candidate.filterProjectId === undefined || typeof candidate.filterProjectId === "string";
  if (candidate.kind === "allAgents") return candidate.filterProjectId === undefined || typeof candidate.filterProjectId === "string";
  if (candidate.kind === "settings") return candidate.section === undefined || ["general", "providers", "notifications"].includes(String(candidate.section));
  if (candidate.kind === "usage") return candidate.projectId === undefined || typeof candidate.projectId === "string";
  if (candidate.kind === "wiki") return candidate.articleId === undefined || typeof candidate.articleId === "string";
  if (typeof candidate.projectId !== "string" || !candidate.projectId) return false;
  if (candidate.kind === "project") return true;
  if (candidate.kind === "workspaceFile") return typeof candidate.path === "string" && Boolean(candidate.path);
  if (candidate.kind === "agents") {
    return (candidate.create === undefined || typeof candidate.create === "boolean")
      && (candidate.managerAgentId === undefined || typeof candidate.managerAgentId === "string")
      && (candidate.continueToTrigger === undefined || typeof candidate.continueToTrigger === "boolean");
  }
  if (candidate.kind === "projectWork") return (candidate.conversationId === undefined || typeof candidate.conversationId === "string")
    && (candidate.focusId === undefined || typeof candidate.focusId === "string");
  if (candidate.kind === "browser") return (candidate.agentId === undefined && candidate.runId === undefined)
    || (typeof candidate.agentId === "string" && Boolean(candidate.agentId) && typeof candidate.runId === "string" && Boolean(candidate.runId));
  if (candidate.kind === "conversation") return typeof candidate.conversationId === "string" && Boolean(candidate.conversationId);
  if (candidate.kind === "agent") return typeof candidate.agentId === "string" && Boolean(candidate.agentId)
    && (candidate.view === undefined || isAgentDetailView(candidate.view))
    && (candidate.createTrigger === undefined || typeof candidate.createTrigger === "boolean");
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
    case "allChats": return "all-chats";
    case "allAgents": return "all-agents";
    case "allTriggers": return "all-triggers";
    case "settings": return "settings";
    case "profile": return "profile";
    case "usage": return `usage:${route.projectId ?? "overall"}`;
    case "wiki": return `wiki:${route.articleId ?? "home"}`;
    case "project": return `project:${route.projectId}`;
    case "workspaceFile": return `workspace-file:${route.projectId}:${route.path}`;
    case "projectWork": return `project-work:${route.projectId}:${route.conversationId ?? "project"}`;
    case "browser": return `browser:${route.projectId}:${route.agentId ?? "project"}:${route.runId ?? "persistent"}`;
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
  const retained = current.filter((tab) => !("projectId" in tab.route) || typeof tab.route.projectId !== "string" || projectIds.has(tab.route.projectId));
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

export function restoreWorkspaceTabs(value: string | null): WorkspaceTabState[] {
  return restoreWorkspaceTabSession(value).tabs;
}
