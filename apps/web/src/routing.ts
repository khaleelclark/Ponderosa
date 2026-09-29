// Lightweight URL-driven navigation (no router dependency). Durable URLs let a
// refresh or browser back/forward restore the exact project + selection:
//
//   / (restore last workspace, otherwise Home)
//   /messages (messages to and from the operator)
//   /projects/:projectId/chats/:conversationId
//   /projects/:projectId/agents/:agentId
//
// Lightweight navigation preferences, such as the last selected project, are
// persisted locally; all real data still comes from the server.

import { useCallback, useEffect, useState } from "react";
import type { AgentTelemetryStream, ConversationChannel } from "@ponderosa/core";
import { routeToPath } from "./routeRegistry.js";

export interface AgentTelemetryFocus {
  stream: AgentTelemetryStream;
  id: string;
}

export type AgentDetailView = "chat" | "activity" | "subagents" | "triggers" | "artifacts" | "settings" | "technical";
export type ConversationDetailView =
  | "main"
  | "collaboration"
  | "files"
  | "agents"
  | "triggers";
export type ProjectDetailView =
  | "overview"
  | "files"
  | "settings";
export type CreateResourceKind = "project" | "chat" | "agent" | "trigger";

const AGENT_DETAIL_VIEWS: readonly AgentDetailView[] = ["chat", "activity", "subagents", "triggers", "artifacts", "settings", "technical"];
const PROJECT_DETAIL_VIEWS: readonly ProjectDetailView[] = [
  "overview",
  "files",
  "settings",
];

const CONVERSATION_DETAIL_VIEWS: readonly ConversationDetailView[] = [
  "main",
  "collaboration",
  "files",
  "agents",
  "triggers",
];

export function isConversationDetailView(
  value: unknown,
): value is ConversationDetailView {
  return typeof value === "string" &&
    (CONVERSATION_DETAIL_VIEWS as readonly string[]).includes(value);
}

export function isAgentDetailView(value: unknown): value is AgentDetailView {
  return typeof value === "string" && (AGENT_DETAIL_VIEWS as readonly string[]).includes(value);
}

export function isProjectDetailView(value: unknown): value is ProjectDetailView {
  return typeof value === "string" && (PROJECT_DETAIL_VIEWS as readonly string[]).includes(value);
}

export type Route =
  | { kind: "home" }
  | {
      kind: "create";
      resource: CreateResourceKind;
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
      surface?: "workspace";
    }
  | { kind: "allChat" }
  | { kind: "manageChats" }
  | { kind: "manageAgents" }
  | { kind: "manageAutomations" }
  | { kind: "settings"; section?: "profile" | "general" | "providers" | "notifications" | "activity" }
  | { kind: "profile" }
  | { kind: "usage"; projectId?: string }
  | { kind: "project"; projectId: string; view?: ProjectDetailView; focusArtifactId?: string }
  | { kind: "workspaceFile"; projectId: string; path: string; agentId?: string; conversationId?: string; returnTo?: string }
  | { kind: "projectWork"; projectId: string; conversationId?: string; focusId?: string }
  | { kind: "browser"; projectId: string; agentId?: string; runId?: string; conversationId?: string }
  | { kind: "conversation"; projectId: string; conversationId: string; focusMessageId?: string; channel?: ConversationChannel; view?: ConversationDetailView; urlDriven?: boolean }
  | { kind: "agent"; projectId: string; agentId: string; focusMessageId?: string; focusTelemetry?: AgentTelemetryFocus; technicalFocusId?: string; view?: AgentDetailView; triggerId?: string; urlDriven?: boolean }
  | { kind: "automation"; projectId: string; triggerId: string; returnTo?: string }
  | { kind: "review"; projectId: string; agentId: string; path?: string; executionId?: string; returnTo?: string };

const LAST_PROJECT_KEY = "ponderosa.lastProjectId";

function decodeRouteSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}

function parseLegacyRoute(pathname: string, search = ""): Route {
  const [cleanPathname, inlineSearch = ""] = pathname.split("?", 2);
  const query = new URLSearchParams(search || (inlineSearch ? `?${inlineSearch}` : ""));
  const focusMessageId = query.get("message")?.trim() || undefined;
  const telemetryStream = query.get("stream")?.trim();
  const telemetryId = query.get("item")?.trim();
  const focusTelemetry = telemetryId && ["runOutput", "activity", "runs", "workItems", "artifacts"].includes(telemetryStream ?? "")
    ? { stream: telemetryStream as AgentTelemetryStream, id: telemetryId }
    : undefined;
  const reviewPath = query.get("path")?.trim() || undefined;
  const technicalFocusId = query.get("focus")?.trim() || undefined;
  const requestedConversationView = query.get("view")?.trim();
  const conversationView = requestedConversationView === "team"
    ? "collaboration" as const
    : requestedConversationView === "automations"
      ? "triggers" as const
      : isConversationDetailView(requestedConversationView)
        ? requestedConversationView
        : undefined;
  const channel = conversationView === "collaboration" ? "collaboration" as const : undefined;
  const requestedAgentView = query.get("view")?.trim();
  const agentView = isAgentDetailView(requestedAgentView) ? requestedAgentView : undefined;
  const projectView = isProjectDetailView(requestedAgentView) ? requestedAgentView : undefined;
  const focusArtifactId = query.get("artifact")?.trim() || undefined;
  const parts = cleanPathname!.split("/").filter(Boolean);
  if (parts[0] === "create" && parts[1] === "project") return {kind:"create",resource:"chat",surface:"workspace"};
  if (parts.length === 0 || parts[0] === "home") return { kind: "home" };
  if (
    parts[0] === "create" &&
    ["project", "chat", "agent", "trigger"].includes(parts[1] ?? "")
  ) {
    return {
      kind: "create",
      resource: parts[1] as CreateResourceKind,
      ...(query.get("project")?.trim()
        ? { projectId: query.get("project")!.trim() }
        : {}),
      ...(query.get("chat")?.trim()
        ? { conversationId: query.get("chat")!.trim() }
        : {}),
      ...(query.get("manager")?.trim()
        ? { managerAgentId: query.get("manager")!.trim() }
        : {}),
      ...(query.get("agent")?.trim()
        ? { agentId: query.get("agent")!.trim() }
        : {}),
      ...(query.get("surface") === "workspace"
        ? { surface: "workspace" as const }
        : {}),
    };
  }
  if (parts.length === 1 && parts[0] === "messages") return { kind: "allChat" };
  if (parts.length === 2 && parts[0] === "manage" && parts[1] === "chats") {
    return { kind: "manageChats" };
  }
  if (parts.length === 2 && parts[0] === "manage" && parts[1] === "agents") {
    return { kind: "manageAgents" };
  }
  if (parts.length === 2 && parts[0] === "manage" && parts[1] === "automations") {
    return { kind: "manageAutomations" };
  }
  if (parts.length === 1 && ["projects", "chats", "agents", "triggers"].includes(parts[0]!)) {
    return { kind: "home" };
  }
  if (parts[0] === "settings") {
    const section = parts[1];
    return { kind: "settings", ...(["profile", "general", "providers", "notifications", "activity"].includes(section ?? "") ? { section: section as "profile" | "general" | "providers" | "notifications" | "activity" } : {}) };
  }
  if (parts.length === 1 && parts[0] === "profile") return { kind: "profile" };
  if (parts.length === 1 && parts[0] === "usage") return { kind: "usage", ...(query.get("project") ? { projectId: query.get("project")! } : {}) };
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "home" };
  }
  const projectId = decodeRouteSegment(parts[1]);
  if (!projectId) return { kind: "home" };
  if (parts[2] === "files" && parts[3] === "view" && query.get("path")) {
    return { kind: "workspaceFile", projectId, path: query.get("path")! };
  }
  if (parts[2] === "work") {
    const conversationId = query.get("chat")?.trim() || undefined;
    const focusId = query.get("focus")?.trim() || undefined;
    return { kind: "projectWork", projectId, ...(conversationId ? { conversationId } : {}), ...(focusId ? { focusId } : {}) };
  }
  if (parts[2] === "agents" && parts[3] && parts[4] === "runs" && parts[5] && parts[6] === "browser") {
    const conversationId = query.get("chat")?.trim() || undefined;
    const agentId = decodeRouteSegment(parts[3]);
    const runId = decodeRouteSegment(parts[5]);
    if (!agentId || !runId) return { kind: "home" };
    return {
      kind: "browser",
      projectId,
      agentId,
      runId,
      ...(conversationId ? { conversationId } : {}),
    };
  }
  if (parts[2] === "browser") return { kind: "browser", projectId };
  if (parts[2] === "automations") {
    const triggerId = parts[3]
      ? decodeRouteSegment(parts[3])
      : undefined;
    if (parts[3] && !triggerId) return { kind: "home" };
    return triggerId
      ? { kind: "automation", projectId, triggerId }
      : { kind: "home" };
  }
  if (parts[2] === "chats" && parts[3]) {
    const conversationId = decodeRouteSegment(parts[3]);
    if (!conversationId) return { kind: "home" };
    return {
      kind: "conversation", projectId, conversationId,
      // A URL is an explicit request to open this conversation. Keep this
      // transient marker out of route serialization so ordinary in-app
      // navigation can continue to restore the user's remembered subtab.
      urlDriven: true,
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(channel ? { channel } : {}),
      ...(conversationView ? { view: conversationView } : {}),
    };
  }
  if (parts[2] === "agents" && parts[3]) {
    const agentId = decodeRouteSegment(parts[3]);
    if (!agentId) return { kind: "home" };
    return {
      kind: "agent", projectId, agentId, urlDriven: true,
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(!focusMessageId && focusTelemetry ? { focusTelemetry } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView ? { view: agentView } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView === "technical" && technicalFocusId ? { technicalFocusId } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView === "triggers" && query.get("trigger")?.trim() ? { triggerId: query.get("trigger")!.trim() } : {}),
    };
  }
  if (parts[2] === "reviews" && parts[3]) {
    const agentId = decodeRouteSegment(parts[3]);
    return agentId
      ? { kind: "review", projectId, agentId, ...(reviewPath ? { path: reviewPath } : {}) }
      : { kind: "home" };
  }
  if (parts[2] === "agents") return { kind: "home" };
  return {
    kind: "project",
    projectId,
    ...(projectView ? { view: projectView } : {}),
    ...(focusArtifactId ? { focusArtifactId } : {}),
  };
}

export function parseRoute(pathname: string, search = ""): Route {
  const route = parseLegacyRoute(pathname, search);
  if (route.kind === "review" || route.kind === "workspaceFile" || route.kind === "automation") {
    const inlineSearch = pathname.split("?", 2)[1];
    const query = new URLSearchParams(search || inlineSearch);
    const returnTo = safeReturnPath(query.get("returnTo") ?? undefined);
    return { ...route, ...(returnTo ? { returnTo } : {}),
      ...(route.kind === "review" && query.get("execution") ? { executionId: query.get("execution")! } : {}),
      ...(route.kind === "workspaceFile" ? { ...(query.get("agentId") ? { agentId: query.get("agentId")! } : {}), ...(query.get("conversationId") ? { conversationId: query.get("conversationId")! } : {}) } : {}),
    };
  }
  return route.kind === "project" ? { kind: "home" } : route;
}

export function safeReturnPath(path: string | undefined): string | undefined {
  if (!path || path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const url = new URL(path, "http://ponderosa.invalid");
  const target = parseLegacyRoute(url.pathname, url.search);
  if (["review", "automation", "workspaceFile", "create"].includes(target.kind)) return undefined;
  return routeToPath(target);
}

export function routeReturnTarget(returnTo: string | undefined, fallback: Route): Route {
  const safe = safeReturnPath(returnTo);
  if (!safe) return fallback;
  const url = new URL(safe, "http://ponderosa.invalid");
  return parseLegacyRoute(url.pathname, url.search);
}

export function routeReturnLabel(target: Route): string {
  return target.kind === "conversation" ? "Back to Chat" : target.kind === "agent" ? "Back to Agent" : target.kind === "manageAutomations" ? "Back to Automations" : target.kind === "project" ? "Back to Files & Results" : target.kind === "allChat" ? "Back to Messages" : "Back to Home";
}

export function parseRouteLocation(
  pathname: string,
  search = "",
): { route: Route; replacement?: string } {
  const route = parseRoute(pathname, search);
  const cleanPathname = pathname.split("?", 1)[0] ?? pathname;
  if (!decodeRouteSegment(cleanPathname)) return { route, replacement: "/" };
  if (
    ["/projects", "/chats", "/agents", "/triggers"].includes(cleanPathname) ||
    /^\/projects\/[^/]+\/?$/u.test(cleanPathname) ||
    /^\/projects\/[^/]+\/(?:agents|automations)\/?$/u.test(cleanPathname)
  ) return { route, replacement: "/home" };
  if (route.kind === "home" && cleanPathname !== "/" && cleanPathname !== "/home") {
    return { route, replacement: "/home" };
  }
  return { route };
}

export function routeProjectId(route: Route): string | undefined {
  return "projectId" in route ? route.projectId : undefined;
}

export const LAST_WORKSPACE_PATH_KEY = "ponderosa.lastWorkspacePath.v1";
export function resolveStartupLocation(pathname: string, search = "", remembered?: string | null): { route: Route; replacement?: string } {
  if (pathname !== "/" || search) return parseRouteLocation(pathname, search);
  if (remembered?.startsWith("/") && !remembered.startsWith("//") && remembered.length < 4096) {
    const url = new URL(remembered, "https://ponderosa.invalid");
    const route = parseRoute(url.pathname, url.search);
    if (route.kind !== "home" && route.kind !== "create" && route.kind !== "browser") return { route, replacement: routeToPath(route) };
  }
  const route: Route = { kind: "home" };
  return { route, replacement: routeToPath(route) };
}

function initialWorkspaceLocation(): { route: Route; replacement?: string } {
  let remembered: string | null = null;
  try { remembered = window.localStorage.getItem(LAST_WORKSPACE_PATH_KEY); } catch { /* Private mode still supports navigation. */ }
  return resolveStartupLocation(window.location.pathname, window.location.search, remembered);
}

export function saveLastProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Ignore storage failures (private mode, quota) — routing still works.
  }
}

export function useRoute(): {
  route: Route;
  navigate(route: Route, options?: { replace?: boolean }): void;
} {
  const [route, setRoute] = useState<Route>(() => initialWorkspaceLocation().route);

  useEffect(() => {
    const onPop = () => {
      const next = parseRouteLocation(
        window.location.pathname,
        window.location.search,
      );
      if (next.replacement) {
        window.history.replaceState(null, "", next.replacement);
      }
      setRoute(next.route);
    };
    const initial = initialWorkspaceLocation();
    if (initial.replacement) window.history.replaceState(null, "", initial.replacement);
    setRoute(initial.route);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (route.kind === "create" || route.kind === "browser" || route.kind === "home") return;
    try { window.localStorage.setItem(LAST_WORKSPACE_PATH_KEY, routeToPath(route)); } catch { /* Storage is optional. */ }
  }, [route]);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    if (next.kind === "create" && next.resource === "project") next = {kind:"create",resource:"chat",surface:"workspace"};
    const path = routeToPath(next);
    if (path === `${window.location.pathname}${window.location.search}`) {
      setRoute(next);
      return;
    }
    if (options?.replace) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
