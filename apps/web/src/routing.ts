// Lightweight URL-driven navigation (no router dependency). Durable URLs let a
// refresh or browser back/forward restore the exact project + selection:
//
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

export interface AgentTelemetryFocus {
  stream: AgentTelemetryStream;
  id: string;
}

export type Route =
  | { kind: "home" }
  | { kind: "projects" }
  | { kind: "allChat" }
  | { kind: "allAgents" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; conversationId: string; focusMessageId?: string; channel?: ConversationChannel }
  | { kind: "agents"; projectId: string }
  | { kind: "agent"; projectId: string; agentId: string; focusMessageId?: string; focusTelemetry?: AgentTelemetryFocus }
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
  const channel = query.get("view") === "team" ? "collaboration" as const : undefined;
  const parts = cleanPathname!.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "projects") return { kind: "projects" };
  if (parts.length === 1 && parts[0] === "chats") return { kind: "allChat" };
  if (parts.length === 1 && parts[0] === "agents") return { kind: "allAgents" };
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "home" };
  }
  const projectId = decodeURIComponent(parts[1]);
  if (parts[2] === "chats" && parts[3]) {
    return {
      kind: "conversation", projectId, conversationId: decodeURIComponent(parts[3]),
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(channel ? { channel } : {}),
    };
  }
  if (parts[2] === "agents" && parts[3]) {
    return {
      kind: "agent", projectId, agentId: decodeURIComponent(parts[3]),
      ...(focusMessageId ? { focusMessageId } : {}),
      ...(!focusMessageId && focusTelemetry ? { focusTelemetry } : {}),
    };
  }
  if (parts[2] === "reviews" && parts[3]) {
    return { kind: "review", projectId, agentId: decodeURIComponent(parts[3]), ...(reviewPath ? { path: reviewPath } : {}) };
  }
  if (parts[2] === "agents") {
    return { kind: "agents", projectId };
  }
  return { kind: "project", projectId };
}

export function routeToPath(route: Route): string {
  switch (route.kind) {
    case "projects":
      return "/projects";
    case "allChat":
      return "/chats";
    case "allAgents":
      return "/agents";
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}`;
    case "conversation": {
      const query = new URLSearchParams();
      if (route.focusMessageId) query.set("message", route.focusMessageId);
      if (route.channel === "collaboration") query.set("view", "team");
      const suffix = query.size ? `?${query.toString()}` : "";
      return `/projects/${encodeURIComponent(route.projectId)}/chats/${encodeURIComponent(route.conversationId)}${suffix}`;
    }
    case "agents":
      return `/projects/${encodeURIComponent(route.projectId)}/agents`;
    case "agent":
      return `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}${
        route.focusMessageId ? `?message=${encodeURIComponent(route.focusMessageId)}`
          : route.focusTelemetry ? `?stream=${encodeURIComponent(route.focusTelemetry.stream)}&item=${encodeURIComponent(route.focusTelemetry.id)}`
            : ""
      }`;
    case "review":
      return `/projects/${encodeURIComponent(route.projectId)}/reviews/${encodeURIComponent(route.agentId)}${route.path ? `?path=${encodeURIComponent(route.path)}` : ""}`;
    default:
      return "/";
  }
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
