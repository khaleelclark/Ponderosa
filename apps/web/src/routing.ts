// Lightweight URL-driven navigation (no router dependency). Durable URLs let a
// refresh or browser back/forward restore the exact project + selection:
//
//   /projects/:projectId/chats/:conversationId
//   /projects/:projectId/agents
//   /projects/:projectId/agents/:agentId
//   /projects
//   /agents
//
// Only a lightweight UI preference (last selected project) is persisted locally;
// all real data still comes from the server.

import { useCallback, useEffect, useState } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "projects" }
  | { kind: "allAgents" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; conversationId: string; messageId?: string }
  | { kind: "agents"; projectId: string }
  | { kind: "agent"; projectId: string; agentId: string };

const LAST_PROJECT_KEY = "ponderosa.lastProjectId";

export function parseRoute(input: string): Route {
  const [pathname = "/", query = ""] = input.split("?", 2);
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "projects") return { kind: "projects" };
  if (parts.length === 1 && parts[0] === "agents") return { kind: "allAgents" };
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "home" };
  }
  const projectId = decodeURIComponent(parts[1]);
  if (parts[2] === "chats" && parts[3]) {
    const messageId = new URLSearchParams(query).get("message")?.trim();
    return { kind: "conversation", projectId, conversationId: decodeURIComponent(parts[3]), ...(messageId ? { messageId } : {}) };
  }
  if (parts[2] === "agents" && parts[3]) {
    return { kind: "agent", projectId, agentId: decodeURIComponent(parts[3]) };
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
    case "allAgents":
      return "/agents";
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}`;
    case "conversation":
      return `/projects/${encodeURIComponent(route.projectId)}/chats/${encodeURIComponent(route.conversationId)}${route.messageId ? `?message=${encodeURIComponent(route.messageId)}` : ""}`;
    case "agents":
      return `/projects/${encodeURIComponent(route.projectId)}/agents`;
    case "agent":
      return `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentId)}`;
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
  const [route, setRoute] = useState<Route>(() => parseRoute(`${window.location.pathname}${window.location.search}`));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(`${window.location.pathname}${window.location.search}`));
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
