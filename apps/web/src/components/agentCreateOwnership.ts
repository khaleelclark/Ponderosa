import type {
  AgentDto,
  ConversationDto,
  WorkspaceAgentDirectoryItemDto,
} from "@ponderosa/core";

export interface AgentCreateOwnership {
  conversationId: string;
  managerAgentId: string;
}

export interface GlobalAgentCreateContext {
  projectId?: string;
  conversationId?: string;
  managerAgentId?: string;
}

export function globalAgentCreateContext(
  rows: readonly WorkspaceAgentDirectoryItemDto[],
  fallbackProjectId: string | undefined,
  managerAgentId: string | undefined,
): GlobalAgentCreateContext | undefined {
  if (!managerAgentId) {
    return fallbackProjectId ? { projectId: fallbackProjectId } : {};
  }
  const manager = rows.find(row => row.agent.id === managerAgentId);
  if (!manager?.ownerConversation) return undefined;
  return {
    projectId: manager.project.id,
    conversationId: manager.ownerConversation.id,
    managerAgentId,
  };
}

export function reconcileAgentCreateOwnership(
  current: AgentCreateOwnership,
  input: {
    agents: readonly Pick<AgentDto, "id" | "conversationId" | "archived">[];
    agentsResolved: boolean;
    chats: readonly Pick<ConversationDto, "id" | "archived" | "deletedAt">[];
    chatsResolved: boolean;
    initialManagerAgentId?: string;
    requiredInitialManagerConversationId?: string;
    fixedConversationId?: string;
    conversationEdited: boolean;
    managerEdited: boolean;
  },
): AgentCreateOwnership {
  const availableChats = input.chats.filter(chat => !chat.archived && !chat.deletedAt);
  const initialManager = !input.managerEdited && input.agentsResolved
    ? input.agents.find(agent =>
        agent.id === input.initialManagerAgentId &&
        !agent.archived &&
        (!input.requiredInitialManagerConversationId ||
          agent.conversationId === input.requiredInitialManagerConversationId) &&
        (!input.chatsResolved ||
          availableChats.some(chat => chat.id === agent.conversationId)))
    : undefined;

  let conversationId = current.conversationId;
  if (input.fixedConversationId) {
    conversationId = input.fixedConversationId;
  } else if (!input.conversationEdited && initialManager) {
    conversationId = initialManager.conversationId;
  } else if (
    input.chatsResolved &&
    !availableChats.some(chat => chat.id === conversationId)
  ) {
    conversationId = availableChats[0]?.id ?? "";
  }

  let managerAgentId = !input.managerEdited && initialManager
    ? initialManager.id
    : current.managerAgentId;
  if (
    input.agentsResolved && managerAgentId &&
    !input.agents.some(agent =>
      agent.id === managerAgentId &&
      !agent.archived &&
      agent.conversationId === conversationId)
  ) {
    managerAgentId = "";
  }

  return { conversationId, managerAgentId };
}
