import type { Route } from "./routing";

type RouteKind = Route["kind"];
type RouteOfKind<Kind extends RouteKind> = Extract<Route, { kind: Kind }>;

export type ProjectRoute = Extract<Route, { projectId: string }>;
export type RouteSidebarSection =
  | "home"
  | "projects"
  | "chats"
  | "agents"
  | "triggers"
  | "settings";


interface RouteRegistryEntry<Kind extends RouteKind> {
  toPath(route: RouteOfKind<Kind>): string;
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
    scope: "global",
    initialSidebarSection: "home",
  },
  create: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.projectId) query.set("project", route.projectId);
      if (route.conversationId) query.set("chat", route.conversationId);
      if (route.managerAgentId) query.set("manager", route.managerAgentId);
      if (route.agentId) query.set("agent", route.agentId);
      if (route.surface) query.set("surface", route.surface);
      return `/create/${route.resource}${query.size ? `?${query.toString()}` : ""}`;
    },
    scope: "global",
    initialSidebarSection: "home",
  },
  projects: {
    toPath: () => "/projects",
    scope: "global",
    initialSidebarSection: "projects",
  },
  allChat: {
    toPath: () => "/messages",
    scope: "global",
    initialSidebarSection: "home",
  },
  allChats: {
    toPath: route =>
      `/chats${route.filterProjectId ? `?project=${encodeURIComponent(route.filterProjectId)}` : ""}`,
    scope: "global",
    initialSidebarSection: "chats",
  },
  allAgents: {
    toPath: route =>
      `/agents${route.filterProjectId ? `?project=${encodeURIComponent(route.filterProjectId)}` : ""}`,
    scope: "global",
    initialSidebarSection: "agents",
  },
  allTriggers: {
    toPath: () => "/triggers",
    scope: "global",
    initialSidebarSection: "triggers",
  },
  settings: {
    toPath: route => `/settings${route.section ? `/${route.section}` : ""}`,
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  profile: {
    toPath: () => "/profile",
    scope: "global",
    initialSidebarSection: "home",
  },
  usage: {
    toPath: route =>
      `/usage${route.projectId ? `?project=${encodeURIComponent(route.projectId)}` : ""}`,
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  project: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}${route.view && route.view !== "overview" ? `?view=${route.view}` : ""}`,
    scope: "project",
    initialSidebarSection: "home",
  },
  workspaceFile: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/files/view?path=${encodeURIComponent(route.path)}`,
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
    scope: "project",
    initialSidebarSection: "home",
  },
  browser: {
    toPath: route => {
      const path = route.agentId && route.runId
        ? `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}/runs/${encodeURIComponent(route.runId)}/browser`
        : `/projects/${encodeURIComponent(route.projectId)}/browser`;
      return route.conversationId
        ? `${path}?chat=${encodeURIComponent(route.conversationId)}`
        : path;
    },
    scope: "project",
    initialSidebarSection: "home",
  },
  conversation: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.focusMessageId) query.set("message", route.focusMessageId);
      const view = route.view ??
        (route.channel === "collaboration" ? "collaboration" : undefined);
      if (view && view !== "main") {
        query.set(
          "view",
          view === "collaboration"
            ? "team"
            : view === "triggers"
              ? "automations"
              : view,
        );
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return `/projects/${encodeURIComponent(route.projectId)}/chats/${encodeURIComponent(route.conversationId)}${suffix}`;
    },
    scope: "project",
    initialSidebarSection: "home",
  },
  agents: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/agents`,
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
      if (route.view === "triggers" && route.triggerId)
        query.set("trigger", route.triggerId);
      return `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}${query.size ? `?${query.toString()}` : ""}`;
    },
    scope: "project",
    initialSidebarSection: "home",
  },
  automation: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/automations${route.triggerId ? `/${encodeURIComponent(route.triggerId)}` : ""}`,
    scope: "project",
    initialSidebarSection: "triggers",
  },
  review: {
    toPath: route =>
      `/projects/${encodeURIComponent(route.projectId)}/reviews/${encodeURIComponent(route.agentId)}${route.path ? `?path=${encodeURIComponent(route.path)}` : ""}`,
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

export function routeInitialSidebarSection(
  route: Route,
): RouteSidebarSection {
  if (route.kind === "create" && route.surface === "workspace") return "home";
  return entryFor(route).initialSidebarSection;
}

export function routeSynchronizedSidebarSection(
  route: Route,
): RouteSidebarSection | undefined {
  if (route.kind === "create" && route.surface === "workspace") return undefined;
  return entryFor(route).synchronizedSidebarSection;
}

export function isProjectRoute(route: Route): route is ProjectRoute {
  return entryFor(route).scope === "project";
}

export function assertNeverRoute(route: never): never {
  throw new Error(`Unhandled route: ${JSON.stringify(route)}`);
}
