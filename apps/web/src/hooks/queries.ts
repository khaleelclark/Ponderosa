import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

export function useProjectFolders(open: boolean) {
  return useQuery({
    queryKey: ["project-folders"],
    queryFn: () => api.getProjectFolders(),
    enabled: open,
  });
}

export function useConversations(projectId: string | undefined) {
  return useQuery({
    queryKey: ["conversations", projectId],
    queryFn: () => api.listConversations(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useAgentHealth(projectId: string | undefined) {
  return useQuery({
    queryKey: ["agent-health", projectId],
    queryFn: () => api.getAgentHealth(projectId ?? ""),
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      const agents = query.state.data?.agents ?? [];
      return agents.some((agent) => agent.status === "running" || agent.status === "waiting" || agent.status === "compacting")
        ? 5_000 : 30_000;
    },
  });
}

export function useConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId ?? ""),
    enabled: Boolean(conversationId),
    // The group chat is the primary surface: poll so agent report-backs and new
    // agents appear without a manual refresh.
    refetchInterval: 4000,
  });
}

export function useCollaborationView(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["collaboration-chat", conversationId],
    queryFn: () => api.getCollaborationView(conversationId ?? ""),
    enabled: Boolean(conversationId),
    refetchInterval: 4000,
  });
}

export function useAgents(projectId: string | undefined) {
  return useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.listAgents(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}
export function useAgentPresets(projectId: string | undefined) {
  return useQuery({ queryKey: ["agent-presets", projectId], queryFn: () => api.listAgentPresets(projectId ?? ""), enabled: Boolean(projectId) });
}

export function useAgent(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId ?? ""),
    enabled: Boolean(agentId),
  });
}

export function useEngines() {
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => api.listEngines(),
  });
}
