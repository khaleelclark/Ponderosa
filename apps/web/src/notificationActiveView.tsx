import type { Route } from "./routing";

export type ActiveNotificationView =
  | { kind: "conversation"; projectId: string; conversationId: string }
  | { kind: "agent"; projectId: string; agentId: string };

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
