import {productWorkspacePath} from "./api/productScope.js";
import type { ConversationDto } from "@ponderosa/core";
import type { Route } from "./routing.js";

type RouteKind = Route["kind"];
type RouteOfKind<Kind extends RouteKind> = Extract<Route, { kind: Kind }>;

export type ProjectRoute = Extract<Route, { projectId: string }>;
export type RouteSidebarSection =
  | "home"
  | "chats"
  | "agents"
  | "settings";

export type ProjectSidebarSection = "chats" | "agents";

export function fixedCreateConversationMatchesProject(
  projectId: string,
  fixedConversationId: string | undefined,
  conversation: Pick<ConversationDto, "id" | "projectId" | "deletedAt"> | undefined,
): boolean {
  return Boolean(
    fixedConversationId &&
    conversation?.id === fixedConversationId &&
    conversation.projectId === projectId &&
    !conversation.deletedAt,
  );
}

export function nestedProjectRouteResources(route: ProjectRoute): {
  agentId?: string;
  conversationId?: string;
} {
  return {
    ...((route.kind === "agent" || route.kind === "review" || route.kind === "browser") && route.agentId
      ? { agentId: route.agentId }
      : {}),
    ...((route.kind === "conversation" || route.kind === "projectWork" || route.kind === "browser") && route.conversationId
      ? { conversationId: route.conversationId }
      : {}),
  };
}

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
    toPath: () => "/home",
    scope: "global",
    initialSidebarSection: "home",
  },
  create: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.projectId) query.set("project", route.projectId);
      if (route.conversationId) query.set("chat", route.conversationId);
      if (route.managerAgentId) query.set("manager", route.managerAgentId);
      if (route.surface) query.set("surface", route.surface);
      if (route.resource === "chat" && route.creationKey) query.set("attempt", route.creationKey);
      return `/create/${route.resource}${query.size ? `?${query.toString()}` : ""}`;
    },
    scope: "global",
    initialSidebarSection: "home",
  },
  allChat: {
    toPath: () => "/messages",
    scope: "global",
    initialSidebarSection: "home",
  },
  manageChats: {
    toPath: () => "/manage/chats",
    scope: "global",
    initialSidebarSection: "chats",
  },
  manageAgents: {
    toPath: () => "/manage/agents",
    scope: "global",
    initialSidebarSection: "agents",
  },
  settings: {
    toPath: route => `/settings${route.section ? `/${route.section}` : ""}${route.returnTo ? `?returnTo=${encodeURIComponent(route.returnTo)}` : ""}`,
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  usage: {
    toPath: route =>
      `/usage${route.projectId ? `?project=${encodeURIComponent(route.projectId)}` : ""}`,
    scope: "global",
    initialSidebarSection: "settings",
    synchronizedSidebarSection: "settings",
  },
  workspaceFile: {
    toPath: route => {
      const query = new URLSearchParams({ path: route.path });
      if (route.agentId) query.set("agentId", route.agentId);
      if (route.conversationId) query.set("conversationId", route.conversationId);
      if (route.returnTo) query.set("returnTo", route.returnTo);
      return `/projects/${encodeURIComponent(route.projectId)}/files/view?${query.toString().replaceAll("+", "%20")}`;
    },
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
            : view,
        );
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return `/projects/${encodeURIComponent(route.projectId)}/chats/${encodeURIComponent(route.conversationId)}${suffix}`;
    },
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
      return `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}${query.size ? `?${query.toString()}` : ""}`;
    },
    scope: "project",
    initialSidebarSection: "home",
  },
  review: {
    toPath: route => {
      const query = new URLSearchParams();
      if (route.path) query.set("path", route.path);
      if (route.executionId) query.set("execution", route.executionId);
      if (route.returnTo) query.set("returnTo", route.returnTo);
      return `/projects/${encodeURIComponent(route.projectId)}/reviews/${encodeURIComponent(route.agentId)}${query.size ? `?${query}` : ""}`;
    },
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

export function projectSidebarSectionForRoute(
  route: Route,
): ProjectSidebarSection | undefined {
  if (route.kind === "conversation") return "chats";
  if (route.kind === "review") return "agents";
  if (route.kind === "agent") {
    return "agents";
  }
  return undefined;
}

export function routeClearsProjectSidebarContext(route: Route): boolean {
  return entryFor(route).scope === "global" &&
    Boolean(routeSynchronizedSidebarSection(route));
}

export function routeWaitsForWorkspacePreferences(
  route: Route,
  preferencesLoaded: boolean,
): boolean {
  return route.kind === "settings" &&
    !preferencesLoaded;
}

export function isProjectRoute(route: Route): route is ProjectRoute {
  return entryFor(route).scope === "project";
}

export function assertNeverRoute(route: never): never {
  throw new Error(`Unhandled route: ${JSON.stringify(route)}`);
}

/** Native links keep modified clicks and new tabs inside the owning product. */
export function routeLinkPath(route:Route):string {return productWorkspacePath(routeToPath(route));}
