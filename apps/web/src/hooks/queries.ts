import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AGENT_DETAIL_PAGE_SIZE } from "../agentHistoryPagination";
import { queryKeys } from "../queryKeys";

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => api.listProjects(),
  });
}

export function useWorkspacePreferences() {
  return useQuery({ queryKey: queryKeys.workspacePreferences.all, queryFn: () => api.getWorkspacePreferences() });
}

export function useNotifications() {
  return useQuery({ queryKey: queryKeys.notifications.all, queryFn: () => api.listNotifications() });
}

export function useAllChat(limit = 50) {
  return useQuery({
    queryKey: queryKeys.allChat(limit),
    queryFn: () => api.getAllChat(limit),
  });
}

export function useConversations(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.conversations.project(projectId),
    queryFn: () => api.listConversations(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
  });
}

export function useAgentHealth(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.health(projectId),
    queryFn: () => api.getAgentHealth(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
    refetchInterval: (query) => {
      const agents = query.state.data?.agents ?? [];
      return agents.some((agent) => agent.status === "running" || agent.status === "waiting" || agent.status === "compacting")
        ? 5_000 : 30_000;
    },
  });
}

export function useConversation(conversationId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: queryKeys.conversations.detail(conversationId, limit),
    queryFn: () => api.getConversation(conversationId ?? "", limit),
    enabled: Boolean(conversationId),
  });
}

export function useCollaborationView(conversationId: string | undefined, limit = 100, enabled = true) {
  return useQuery({
    queryKey: queryKeys.collaboration(conversationId, limit),
    queryFn: () => api.getCollaborationView(conversationId ?? "", limit),
    enabled: Boolean(conversationId) && enabled,
  });
}

export function useAgents(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
    // The query follows every server page so no first-page snapshot becomes
    // authoritative. Agent health provides the high-frequency live status path.
    refetchInterval: 30_000,
  });
}
export function useAgentPresets(projectId: string | undefined) {
  return useQuery({ queryKey: queryKeys.agents.presets(projectId), queryFn: () => api.listAgentPresets(projectId ?? ""), enabled: Boolean(projectId) });
}

export function useAgent(
  agentId: string | undefined,
  limit = AGENT_DETAIL_PAGE_SIZE,
) {
  return useQuery({
    queryKey: queryKeys.agents.detail(agentId, limit),
    queryFn: () => api.getAgent(agentId ?? "", limit),
    enabled: Boolean(agentId),
  });
}

export function useEngines() {
  return useQuery({
    queryKey: queryKeys.engines.all,
    queryFn: () => api.listEngines(),
  });
}
