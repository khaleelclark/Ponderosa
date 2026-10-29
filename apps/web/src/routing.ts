// Lightweight URL-driven navigation (no router dependency). Durable URLs let a
// refresh or browser back/forward restore the Chat or Agent selection:
//
//   / (restore last workspace, otherwise Home)
//   /messages (messages to and from the operator)
//   /projects/:projectId/chats/:conversationId
//   /projects/:projectId/agents/:agentId
//
// Lightweight navigation preferences, such as the last selected resource, are
// persisted locally; all real data still comes from the server.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTelemetryStream, ConversationChannel } from "@ponderosa/core";
import { confirmUnsavedNavigation, reloadBlockers } from "./reloadSafety.js";
import { routeToPath } from "./routeRegistry.js";

export interface AgentTelemetryFocus {
  stream: AgentTelemetryStream;
  id: string;
}

export type AgentDetailView = "chat" | "activity" | "subagents" | "artifacts" | "settings" | "technical";
export type ConversationDetailView =
  | "main"
  | "collaboration"
  | "files"
  | "agents";
export type CreateResourceKind = "chat" | "agent";

const AGENT_DETAIL_VIEWS: readonly AgentDetailView[] = ["chat", "activity", "subagents", "artifacts", "settings", "technical"];
const CONVERSATION_DETAIL_VIEWS: readonly ConversationDetailView[] = [
  "main",
  "collaboration",
  "files",
  "agents",
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

export type Route =
  | { kind: "home" }
  | {
      kind: "create";
      resource: CreateResourceKind;
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      surface?: "workspace";
      creationKey?: string;
    }
  | { kind: "inbox" }
  | { kind: "manageChats" }
  | { kind: "manageAgents" }
  | { kind: "settings"; returnTo?: string; section?: "profile" | "general" | "providers" | "notifications" | "activity" }
  | { kind: "usage"; projectId?: string }
  | { kind: "workspaceFile"; projectId: string; path: string; agentId?: string; conversationId?: string; returnTo?: string }
  | { kind: "projectWork"; projectId: string; conversationId?: string; focusId?: string }
  | { kind: "browser"; projectId: string; agentId?: string; runId?: string; conversationId?: string }
  | { kind: "conversation"; projectId: string; conversationId: string; focusMessageId?: string; channel?: ConversationChannel; view?: ConversationDetailView; urlDriven?: boolean }
  | { kind: "agent"; projectId: string; agentId: string; focusMessageId?: string; focusTelemetry?: AgentTelemetryFocus; technicalFocusId?: string; view?: AgentDetailView; urlDriven?: boolean }
  | { kind: "review"; projectId: string; agentId: string; path?: string; executionId?: string; returnTo?: string };

function decodeRouteSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}

function parseRoutePath(pathname: string, search = ""): Route {
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
    : isConversationDetailView(requestedConversationView)
      ? requestedConversationView
      : undefined;
  const channel = conversationView === "collaboration" ? "collaboration" as const : undefined;
  const requestedAgentView = query.get("view")?.trim();
  const agentView = isAgentDetailView(requestedAgentView) ? requestedAgentView : undefined;
  const parts = cleanPathname!.split("/").filter(Boolean);
  if (parts.length === 0 || parts[0] === "home") return { kind: "home" };
  if (
    parts[0] === "create" &&
    ["chat", "agent"].includes(parts[1] ?? "")
  ) {
    return {
      kind: "create",
      resource: parts[1] as CreateResourceKind,
      ...(parts[1] === "chat" && /^[A-Za-z0-9_-]{8,128}$/u.test(query.get("attempt") ?? "")
        ? { creationKey: query.get("attempt")! }
        : {}),
      ...(query.get("project")?.trim()
        ? { projectId: query.get("project")!.trim() }
        : {}),
      ...(query.get("chat")?.trim()
        ? { conversationId: query.get("chat")!.trim() }
        : {}),
      ...(query.get("manager")?.trim()
        ? { managerAgentId: query.get("manager")!.trim() }
        : {}),
      ...(query.get("surface") === "workspace"
        ? { surface: "workspace" as const }
        : {}),
    };
  }
  if (parts.length === 1 && parts[0] === "messages") return { kind: "inbox" };
  if (parts.length === 2 && parts[0] === "manage" && parts[1] === "chats") {
    return { kind: "manageChats" };
  }
  if (parts.length === 2 && parts[0] === "manage" && parts[1] === "agents") {
    return { kind: "manageAgents" };
  }
  if (parts.length === 1 && ["projects", "chats", "agents"].includes(parts[0]!)) {
    return { kind: "home" };
  }
  if (parts[0] === "settings") {
    const section = parts[1];
    return { kind: "settings", ...(["profile", "general", "providers", "notifications", "activity"].includes(section ?? "") ? { section: section as "profile" | "general" | "providers" | "notifications" | "activity" } : {}) };
  }
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
  if (parts[2] === "browser") {
    const conversationId = query.get("chat")?.trim() || undefined;
    return { kind: "browser", projectId, ...(conversationId ? { conversationId } : {}) };
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
    };
  }
  if (parts[2] === "reviews" && parts[3]) {
    const agentId = decodeRouteSegment(parts[3]);
    return agentId
      ? { kind: "review", projectId, agentId, ...(reviewPath ? { path: reviewPath } : {}) }
      : { kind: "home" };
  }
  return { kind: "home" };
}

export function parseRoute(pathname: string, search = ""): Route {
  const route = parseRoutePath(pathname, search);
  if (route.kind === "review" || route.kind === "workspaceFile" || route.kind === "settings") {
    const inlineSearch = pathname.split("?", 2)[1];
    const query = new URLSearchParams(search || inlineSearch);
    const returnTo = route.kind === "settings"
      ? safeSettingsReturnPath(query.get("returnTo") ?? undefined)
      : safeReturnPath(query.get("returnTo") ?? undefined);
    return { ...route, ...(returnTo ? { returnTo } : {}),
      ...(route.kind === "review" && query.get("execution") ? { executionId: query.get("execution")! } : {}),
      ...(route.kind === "workspaceFile" ? { ...(query.get("agentId") ? { agentId: query.get("agentId")! } : {}), ...(query.get("conversationId") ? { conversationId: query.get("conversationId")! } : {}) } : {}),
    };
  }
  return route;
}

export function safeReturnPath(path: string | undefined): string | undefined {
  if (!path || path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const url = new URL(path, "http://ponderosa.invalid");
  const target = parseRoutePath(url.pathname, url.search);
  if (["review", "workspaceFile", "create"].includes(target.kind)) return undefined;
  return routeToPath(target);
}

function safeSettingsReturnPath(path: string | undefined): string | undefined {
  const safe = safeReturnPath(path);
  if (!safe) return undefined;
  const url = new URL(safe, "http://ponderosa.invalid");
  const target = parseRoutePath(url.pathname, url.search);
  return target.kind === "settings" ? undefined : safe;
}

export function routeReturnTarget(returnTo: string | undefined, fallback: Route): Route {
  const safe = safeReturnPath(returnTo);
  if (!safe) return fallback;
  const url = new URL(safe, "http://ponderosa.invalid");
  return parseRoutePath(url.pathname, url.search);
}

export function routeReturnLabel(target: Route): string {
  return target.kind === "conversation" ? "Back to Chat" : target.kind === "agent" ? "Back to Agent" : target.kind === "inbox" ? "Back to Inbox" : "Back to Home";
}

export function parseRouteLocation(
  pathname: string,
  search = "",
): { route: Route; replacement?: string } {
  const route = parseRoute(pathname, search);
  const cleanPathname = pathname.split("?", 1)[0] ?? pathname;
  if (!decodeRouteSegment(cleanPathname)) return { route, replacement: "/" };
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

export function navigationPreservesSettings(current: Route, next: Route): boolean {
  // Parent Settings drafts survive subsection changes. Profile and permission
  // editors unmount, so their pending edits still need the discard guard.
  return current.kind === "settings" && next.kind === "settings" &&
    current.section !== "profile" && next.section !== "profile" &&
    !reloadBlockers().includes("tool-permissions:/api/workspace/capabilities");
}

export function useRoute(): {
  route: Route;
  navigate(route: Route, options?: { replace?: boolean }): boolean;
} {
  const [route, setRoute] = useState<Route>(() => initialWorkspaceLocation().route);

  const currentRoute = useRef(route);
  currentRoute.current = route;
  const acceptedLocation = useRef(`${window.location.pathname}${window.location.search}`);
  useEffect(() => {
    const onPop = () => {
      const next = parseRouteLocation(
        window.location.pathname,
        window.location.search,
      );
      if (!navigationPreservesSettings(currentRoute.current, next.route) && !confirmUnsavedNavigation()) {
        window.history.pushState(null, "", acceptedLocation.current);
        return;
      }
      acceptedLocation.current = next.replacement ?? `${window.location.pathname}${window.location.search}`;
      if (next.replacement) {
        window.history.replaceState(null, "", next.replacement);
      }
      setRoute(next.route);
    };
    const initial = initialWorkspaceLocation();
    if (initial.replacement) window.history.replaceState(null, "", initial.replacement);
    acceptedLocation.current = `${window.location.pathname}${window.location.search}`;
    setRoute(initial.route);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (route.kind === "create" || route.kind === "browser" || route.kind === "home") return;
    try { window.localStorage.setItem(LAST_WORKSPACE_PATH_KEY, routeToPath(route)); } catch { /* Storage is optional. */ }
  }, [route]);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    if (next.kind === "settings") {
      const previous = currentRoute.current;
      const returnTo = safeSettingsReturnPath(next.returnTo ?? ((previous.kind === "settings")
        ? previous.returnTo : routeToPath(previous)));
      next = { ...next, returnTo };
    } else if ("returnTo" in next) {
      next = { ...next, returnTo: safeReturnPath(next.returnTo) };
    }
    const path = routeToPath(next);
    if (path === `${window.location.pathname}${window.location.search}`) {
      setRoute(next);
      return true;
    }
    if (!navigationPreservesSettings(currentRoute.current, next) && !confirmUnsavedNavigation()) return false;
    acceptedLocation.current = path;
    if (options?.replace) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
    return true;
  }, []);

  return { route, navigate };
}
