import type { Route } from "./routing";

type RouteKind = Route["kind"];
type RouteOfKind<Kind extends RouteKind> = Extract<Route, { kind: Kind }>;

export type ProjectRoute = Extract<Route, { projectId: string }>;
export type RouteTabIcon =
  | "add"
  | "agent"
  | "bolt"
  | "chat"
  | "dataUsage"
  | "difference"
  | "folder"
  | "home"
  | "language"
  | "menuBook"
  | "person"
  | "settings";
export type RouteSidebarSection =
  | "create"
  | "home"
  | "projects"
  | "chats"
  | "agents"
  | "triggers"
  | "wiki"
  | "settings";

export interface RouteTabLabelContext {
  conversationTitle(conversationId: string): string | undefined;
  agentTitle(agentId: string): string | undefined;
  projectLabel?: string;
}

interface RouteRegistryEntry<Kind extends RouteKind> {
  toPath(route: RouteOfKind<Kind>): string;
  workspaceTabKey(route: RouteOfKind<Kind>): string;
  tabLabel(
    route: RouteOfKind<Kind>,
    context: RouteTabLabelContext,
  ): string;
  tabIcon: RouteTabIcon;
  scope: "global" | "project";
  initialSidebarSection: RouteSidebarSection;
  synchronizedSidebarSection?: RouteSidebarSection;
}

type RouteRegistry = {
  [Kind in RouteKind]: RouteRegistryEntry<Kind>;
};

const ROUTE_REGISTRY = {
  home: {
    toPath: () => "/",
    workspaceTabKey: () => "home",
    tabLabel: () => "Home",
    tabIcon: "home",
    scope: "global",
    initialSidebarSection: "home",
  },
  create: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.projectId) query.set("project", route.projectId);
      if (route.managerAgentId) query.set("manager", route.managerAgentId);
      if (route.agentId) query.set("agent", route.agentId);
      return `/create/${route.resource}${query.size ? `?${query.toString()}` : ""}`;
    },
    workspaceTabKey: () => "create",
    tabLabel: route =>
      `Create ${route.resource.charAt(0).toUpperCase()}${route.resource.slice(1)}`,
    tabIcon: "add",
    scope: "global",
    initialSidebarSection: "create",
    synchronizedSidebarSection: "create",
  },
  projects: {
    toPath: () => "/projects",
    workspaceTabKey: () => "projects",
    tabLabel: () => "All Projects",
    tabIcon: "folder",
    scope: "global",
    initialSidebarSection: "projects",
  },
  allChat: {
    toPath: () => "/messages",
    workspaceTabKey: () => "all-chat",
    tabLabel: () => "Messages Across Ponderosa",
    tabIcon: "chat",
    scope: "global",
    initialSidebarSection: "home",
  },
  allChats: {
    toPath: route =>
      `/chats${route.filterProjectId ? `?project=${encodeURIComponent(route.filterProjectId)}` : ""}`,
    workspaceTabKey: () => "all-chats",
    tabLabel: () => "All Chats",
    tabIcon: "chat",
    scope: "global",
    initialSidebarSection: "chats",
  },
  allAgents: {
    toPath: route =>
      `/agents${route.filterProjectId ? `?project=${encodeURIComponent(route.filterProjectId)}` : ""}`,
    workspaceTabKey: () => "all-agents",
    tabLabel: () => "All Agents",
    tabIcon: "agent",
    scope: "global",
    initialSidebarSection: "agents",
  },
  allTriggers: {
    toPath: () => "/triggers",
    workspaceTabKey: () => "all-triggers",
    tabLabel: () => "All Triggers",
    tabIcon: "bolt",
    scope: "global",
    initialSidebarSection: "triggers",
  },
  settings: {
    toPath: route => `/settings${route.section ? `/${route.section}` : ""}`,
    workspaceTabKey: () => "settings",
    tabLabel: () => "Settings",
    tabIcon: "settings",
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  profile: {
    toPath: () => "/profile",
    workspaceTabKey: () => "profile",
    tabLabel: () => "Operator Profile",
    tabIcon: "person",
    scope: "global",
    initialSidebarSection: "home",
  },
  usage: {
    toPath: route =>
      `/usage${route.projectId ? `?project=${encodeURIComponent(route.projectId)}` : ""}`,
    workspaceTabKey: route => `usage:${route.projectId ?? "overall"}`,
    tabLabel: () => "Provider Activity",
    tabIcon: "dataUsage",
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  wiki: {
    toPath: route =>
      `/wiki${route.articleId ? `/${encodeURIComponent(route.articleId)}` : ""}`,
    workspaceTabKey: route => `wiki:${route.articleId ?? "home"}`,
    tabLabel: () => "Wiki",
    tabIcon: "menuBook",
    scope: "global",
    initialSidebarSection: "wiki",
    synchronizedSidebarSection: "wiki",
  },
  project: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}${route.view && route.view !== "overview" ? `?view=${route.view}` : ""}`,
    workspaceTabKey: route => `project:${route.projectId}`,
    tabLabel: (_route, context) => context.projectLabel ?? "Project Overview",
    tabIcon: "folder",
    scope: "project",
    initialSidebarSection: "home",
  },
  workspaceFile: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/files/view?path=${encodeURIComponent(route.path)}`,
    workspaceTabKey: route =>
      `workspace-file:${route.projectId}:${route.path}`,
    tabLabel: route => route.path.split(/[\\/]/u).at(-1) ?? "File",
    tabIcon: "folder",
    scope: "project",
    initialSidebarSection: "home",
  },
  projectWork: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.conversationId) query.set("chat", route.conversationId);
      if (route.focusId) query.set("focus", route.focusId);
      return `/projects/${encodeURIComponent(route.projectId)}/work${query.size ? `?${query.toString()}` : ""}`;
    },
    workspaceTabKey: route =>
      `project-work:${route.projectId}:${route.conversationId ?? "project"}`,
    tabLabel: () => "Work",
    tabIcon: "folder",
    scope: "project",
    initialSidebarSection: "home",
  },
  browser: {
    toPath: route =>
      route.agentId && route.runId
        ? `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}/runs/${encodeURIComponent(route.runId)}/browser`
        : `/projects/${encodeURIComponent(route.projectId)}/browser`,
    workspaceTabKey: route =>
      `browser:${route.projectId}:${route.agentId ?? "project"}:${route.runId ?? "persistent"}`,
    tabLabel: () => "Interactive Browser",
    tabIcon: "language",
    scope: "project",
    initialSidebarSection: "home",
  },
  conversation: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.focusMessageId) query.set("message", route.focusMessageId);
      if (route.channel === "collaboration") query.set("view", "team");
      const suffix = query.size ? `?${query.toString()}` : "";
      return `/projects/${encodeURIComponent(route.projectId)}/chats/${encodeURIComponent(route.conversationId)}${suffix}`;
    },
    workspaceTabKey: route =>
      `conversation:${route.projectId}:${route.conversationId}`,
    tabLabel: (route, context) =>
      context.conversationTitle(route.conversationId) ?? "Chat",
    tabIcon: "chat",
    scope: "project",
    initialSidebarSection: "home",
  },
  agents: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/agents${route.create || route.managerAgentId || route.continueToTrigger
        ? `?${new URLSearchParams({
          ...(route.create ? { create: "1" } : {}),
          ...(route.managerAgentId ? { manager: route.managerAgentId } : {}),
          ...(route.continueToTrigger ? { continue: "trigger" } : {}),
        }).toString()}`
        : ""}`,
    workspaceTabKey: route => `agents:${route.projectId}`,
    tabLabel: () => "Agents",
    tabIcon: "agent",
    scope: "project",
    initialSidebarSection: "home",
  },
  agent: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.focusMessageId) query.set("message", route.focusMessageId);
      else if (route.focusTelemetry) {
        query.set("stream", route.focusTelemetry.stream);
        query.set("item", route.focusTelemetry.id);
      } else if (route.view) query.set("view", route.view);
      if (route.view === "technical" && route.technicalFocusId)
        query.set("focus", route.technicalFocusId);
      if (route.view === "triggers" && route.createTrigger)
        query.set("create", "1");
      if (route.view === "triggers" && route.triggerId)
        query.set("trigger", route.triggerId);
      return `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}${query.size ? `?${query.toString()}` : ""}`;
    },
    workspaceTabKey: route => `agent:${route.projectId}:${route.agentId}`,
    tabLabel: (route, context) =>
      context.agentTitle(route.agentId) ?? "Agent",
    tabIcon: "agent",
    scope: "project",
    initialSidebarSection: "home",
  },
  review: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/reviews/${encodeURIComponent(route.agentId)}${route.path ? `?path=${encodeURIComponent(route.path)}` : ""}`,
    workspaceTabKey: route =>
      `review:${route.projectId}:${route.agentId}:${route.path ?? "all"}`,
    tabLabel: (route, context) =>
      route.path?.split(/[\\/]/u).at(-1) ??
      `${context.agentTitle(route.agentId) ?? "Agent"} Review`,
    tabIcon: "difference",
    scope: "project",
    initialSidebarSection: "home",
  },
} satisfies RouteRegistry;

function entryFor(route: Route): RouteRegistryEntry<RouteKind> {
  return ROUTE_REGISTRY[route.kind] as RouteRegistryEntry<RouteKind>;
}

export function routeToPath(route: Route): string {
  return entryFor(route).toPath(route);
}

export function workspaceTabKey(route: Route): string {
  return entryFor(route).workspaceTabKey(route);
}

export function routeTabLabel(
  route: Route,
  context: RouteTabLabelContext,
): string {
  return entryFor(route).tabLabel(route, context);
}

export function routeTabIcon(route: Route): RouteTabIcon {
  return entryFor(route).tabIcon;
}

export function routeInitialSidebarSection(
  route: Route,
): RouteSidebarSection {
  return entryFor(route).initialSidebarSection;
}

export function routeSynchronizedSidebarSection(
  route: Route,
): RouteSidebarSection | undefined {
  return entryFor(route).synchronizedSidebarSection;
}

export function isProjectRoute(route: Route): route is ProjectRoute {
  return entryFor(route).scope === "project";
}

export function isRouteKind(value: unknown): value is RouteKind {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ROUTE_REGISTRY, value);
}

export function assertNeverRoute(route: never): never {
  throw new Error(`Unhandled route: ${JSON.stringify(route)}`);
}
