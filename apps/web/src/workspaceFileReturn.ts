import type { AgentDto, ConversationDto } from "@ponderosa/core";
import type { Route } from "./routing.js";

export function workspaceFileReturnFallback(
  route: Extract<Route, { kind: "workspaceFile" }>,
  agents: readonly Pick<AgentDto, "id" | "projectId">[],
  chats: readonly Pick<ConversationDto, "id" | "projectId" | "deletedAt">[],
): Route {
  const owner = route.agentId ? agents.find(agent => agent.id === route.agentId && agent.projectId === route.projectId) : undefined;
  const chat = route.conversationId ? chats.find(chat => chat.id === route.conversationId && chat.projectId === route.projectId && !chat.deletedAt) : undefined;
  return owner ? { kind: "agent", projectId: route.projectId, agentId: owner.id, view: "artifacts" }
    : chat ? { kind: "conversation", projectId: route.projectId, conversationId: chat.id, view: "files" }
      : { kind: "home" };
}
