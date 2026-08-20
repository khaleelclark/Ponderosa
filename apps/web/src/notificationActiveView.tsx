import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { createContext, useContext } from "react";
import type { Route } from "./routing";

export type ActiveNotificationView =
  | { kind: "conversation"; projectId: string; conversationId: string }
  | { kind: "agent"; projectId: string; agentId: string };

export type NotificationDestination = Pick<
  WorkspaceNotificationDto,
  "projectId" | "conversationId" | "agentId"
>;

export function activeNotificationViewForRoute(
  route: Route,
  visible: boolean,
): ActiveNotificationView | undefined {
  if (!visible) return undefined;
  if (route.kind === "conversation") {
    return {
      kind: "conversation",
      projectId: route.projectId,
      conversationId: route.conversationId,
    };
  }
  if (route.kind === "agent") {
    return { kind: "agent", projectId: route.projectId, agentId: route.agentId };
  }
  return undefined;
}

export function notificationMatchesActiveView(
  notification: NotificationDestination,
  activeView: ActiveNotificationView | undefined,
): boolean {
  if (!activeView || notification.projectId !== activeView.projectId) return false;
  return activeView.kind === "conversation"
    ? notification.conversationId === activeView.conversationId
    : notification.agentId === activeView.agentId;
}

const ActiveNotificationViewContext = createContext<ActiveNotificationView | undefined>(undefined);

export const ActiveNotificationViewProvider = ActiveNotificationViewContext.Provider;

export function useActiveNotificationView(): ActiveNotificationView | undefined {
  return useContext(ActiveNotificationViewContext);
}
