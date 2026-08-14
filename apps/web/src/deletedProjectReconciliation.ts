import type { QueryClient } from "@tanstack/react-query";
import { reconcileDeletedProjectClientState } from "./hooks/useWorkspaceStream";
import type { Route } from "./routing";
import {
  removeProjectWorkspaceTabsWithFallback,
  type WorkspaceTabState,
} from "./workspaceTabs";

const DELETED_PROJECT_FALLBACK: Route = { kind: "projects" };

export interface DeletedProjectWorkspaceReconciliation {
  tabs: WorkspaceTabState[];
  activeRouteDeleted: boolean;
  fallback: Route;
}

/** One client-side lifecycle boundary shared by live SSE and local DELETE
 * completion, including clients whose workspace stream is disconnected. */
export function reconcileDeletedProjectWorkspace(
  queryClient: QueryClient,
  tabs: WorkspaceTabState[],
  activeKey: string,
  projectId: string,
  at: string,
): DeletedProjectWorkspaceReconciliation {
  reconcileDeletedProjectClientState(queryClient, projectId, at);
  const activeRoute = tabs.find(tab => tab.key === activeKey)?.route;
  return {
    tabs: removeProjectWorkspaceTabsWithFallback(
      tabs,
      activeKey,
      projectId,
      DELETED_PROJECT_FALLBACK,
    ),
    activeRouteDeleted: Boolean(
      activeRoute && "projectId" in activeRoute && activeRoute.projectId === projectId,
    ),
    fallback: DELETED_PROJECT_FALLBACK,
  };
}
