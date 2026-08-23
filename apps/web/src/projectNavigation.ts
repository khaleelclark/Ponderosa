import { isProjectRoute } from "./routeRegistry";
import type { Route } from "./routing";

const PROJECT_ROUTE_HISTORY_KEY = "ponderosa.projectRouteHistory.v1";

function readHistory(): Record<string, Route> {
  try {
    const value = window.localStorage.getItem(PROJECT_ROUTE_HISTORY_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as Record<string, Route>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberProjectRoute(route: Route): void {
  if (!isProjectRoute(route)) return;
  try {
    const history = readHistory();
    history[route.projectId] = route;
    window.localStorage.setItem(PROJECT_ROUTE_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Device-local navigation history is optional.
  }
}

export function restoreProjectRoute(
  projectId: string,
  fallbackConversationId?: string,
): Route {
  const remembered = readHistory()[projectId];
  if (
    remembered &&
    isProjectRoute(remembered) &&
    remembered.projectId === projectId
  ) {
    return remembered;
  }
  return fallbackConversationId
    ? { kind: "conversation", projectId, conversationId: fallbackConversationId }
    : { kind: "project", projectId };
}

