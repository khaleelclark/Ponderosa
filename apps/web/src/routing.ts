// Lightweight URL-driven navigation (no router dependency). Durable URLs let a
// refresh or browser back/forward restore the exact project + selection:
//
//   / (Home overview)
//   /messages (messages to and from the operator)
//   /chats (legacy Messages route)
//   /projects/:projectId/chats/:conversationId
//   /projects/:projectId/agents
//   /projects/:projectId/agents/:agentId
//   /projects
//   /agents
//
// Lightweight navigation preferences (the last selected project and open
// workspace-tab routes) are persisted locally; all real data still comes from
// the server.

import { useCallback, useEffect, useState } from "react";
import type { AgentTelemetryStream, ConversationChannel } from "@ponderosa/core";
import { routeToPath } from "./routeRegistry";

export interface AgentTelemetryFocus {
  stream: AgentTelemetryStream;
  id: string;
}

export type AgentDetailView = "chat" | "activity" | "subagents" | "triggers" | "artifacts" | "settings" | "technical";
export type ProjectDetailView =
  | "overview"
  | "files"
  | "agents"
  | "triggers"
  | "settings";
export type CreateResourceKind = "project" | "chat" | "agent" | "trigger";

const AGENT_DETAIL_VIEWS: readonly AgentDetailView[] = ["chat", "activity", "subagents", "triggers", "artifacts", "settings", "technical"];
const PROJECT_DETAIL_VIEWS: readonly ProjectDetailView[] = [
  "overview",
  "files",
  "agents",
  "triggers",
  "settings",
];

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
  | { kind: "projects" }
  | { kind: "allChat" }
  | { kind: "allChats"; filterProjectId?: string }
  | { kind: "allAgents"; filterProjectId?: string }
  | { kind: "allTriggers" }
  | { kind: "settings"; section?: "general" | "providers" | "notifications" | "activity" }
  | { kind: "profile" }
  | { kind: "usage"; projectId?: string }
  | { kind: "wiki"; articleId?: string }
  | { kind: "project"; projectId: string; view?: ProjectDetailView }
  | { kind: "workspaceFile"; projectId: string; path: string }
  | { kind: "projectWork"; projectId: string; conversationId?: string; focusId?: string }
  | { kind: "browser"; projectId: string; agentId?: string; runId?: string }
  | { kind: "conversation"; projectId: string; conversationId: string; focusMessageId?: string; channel?: ConversationChannel; urlDriven?: boolean }
  | { kind: "agents"; projectId: string }
  | { kind: "agent"; projectId: string; agentId: string; focusMessageId?: string; focusTelemetry?: AgentTelemetryFocus; technicalFocusId?: string; view?: AgentDetailView; triggerId?: string }
  | { kind: "review"; projectId: string; agentId: string; path?: string };

const LAST_PROJECT_KEY = "ponderosa.lastProjectId";

export function parseRoute(pathname: string, search = ""): Route {
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
  const channel = query.get("view") === "team" ? "collaboration" as const : undefined;
  const requestedAgentView = query.get("view")?.trim();
  const agentView = isAgentDetailView(requestedAgentView) ? requestedAgentView : undefined;
  const projectView = isProjectDetailView(requestedAgentView) ? requestedAgentView : undefined;
  const parts = cleanPathname!.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "home" };
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
  if (parts.length === 1 && parts[0] === "projects") return { kind: "projects" };
  if (parts.length === 1 && parts[0] === "chats") return { kind: "allChats", ...(query.get("project") ? { filterProjectId: query.get("project")! } : {}) };
  if (parts.length === 1 && parts[0] === "agents") return { kind: "allAgents", ...(query.get("project") ? { filterProjectId: query.get("project")! } : {}) };
  if (parts.length === 1 && parts[0] === "triggers") return { kind: "allTriggers" };
  if (parts[0] === "settings") {
    const section = parts[1];
    return { kind: "settings", ...(["general", "providers", "notifications", "activity"].includes(section ?? "") ? { section: section as "general" | "providers" | "notifications" | "activity" } : {}) };
  }
  if (parts.length === 1 && parts[0] === "profile") return { kind: "profile" };
  if (parts.length === 1 && parts[0] === "usage") return { kind: "usage", ...(query.get("project") ? { projectId: query.get("project")! } : {}) };
  if (parts[0] === "wiki") return { kind: "wiki", ...(parts[1] ? { articleId: decodeURIComponent(parts[1]) } : {}) };
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "home" };
  }
  const projectId = decodeURIComponent(parts[1]);
  if (parts[2] === "files" && parts[3] === "view" && query.get("path")) {
    return { kind: "workspaceFile", projectId, path: query.get("path")! };
  }
  if (parts[2] === "work") {
    const conversationId = query.get("chat")?.trim() || undefined;
    const focusId = query.get("focus")?.trim() || undefined;
    return { kind: "projectWork", projectId, ...(conversationId ? { conversationId } : {}), ...(focusId ? { focusId } : {}) };
  }
  if (parts[2] === "agents" && parts[3] && parts[4] === "runs" && parts[5] && parts[6] === "browser") {
    return { kind: "browser", projectId, agentId: decodeURIComponent(parts[3]), runId: decodeURIComponent(parts[5]) };
  }
  if (parts[2] === "browser") return { kind: "browser", projectId };
  if (parts[2] === "chats" && parts[3]) {
    return {
      kind: "conversation", projectId, conversationId: decodeURIComponent(parts[3]),
      // A URL is an explicit request to open this conversation. Keep this
      // transient marker out of route serialization so ordinary in-app
      // navigation can continue to restore the user's remembered subtab.
      urlDriven: true,
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(channel ? { channel } : {}),
    };
  }
  if (parts[2] === "agents" && parts[3]) {
    return {
      kind: "agent", projectId, agentId: decodeURIComponent(parts[3]),
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(!focusMessageId && focusTelemetry ? { focusTelemetry } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView ? { view: agentView } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView === "technical" && technicalFocusId ? { technicalFocusId } : {}),
      ...(!focusMessageId && !focusTelemetry && agentView === "triggers" && query.get("trigger")?.trim() ? { triggerId: query.get("trigger")!.trim() } : {}),
    };
  }
  if (parts[2] === "reviews" && parts[3]) {
    return { kind: "review", projectId, agentId: decodeURIComponent(parts[3]), ...(reviewPath ? { path: reviewPath } : {}) };
  }
  if (parts[2] === "agents") {
    return { kind: "agents", projectId };
  }
  return {
    kind: "project",
    projectId,
    ...(projectView ? { view: projectView } : {}),
  };
}

export function routeProjectId(route: Route): string | undefined {
  return "projectId" in route ? route.projectId : undefined;
}

export function loadLastProjectId(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
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
