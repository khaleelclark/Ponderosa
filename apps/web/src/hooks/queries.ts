import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

export function useWorkspacePreferences() {
  return useQuery({ queryKey: ["workspace-preferences"], queryFn: () => api.getWorkspacePreferences() });
}

export function useNotifications() {
  return useQuery({ queryKey: ["notifications"], queryFn: () => api.listNotifications() });
}

export function useAllChat(limit = 50) {
  return useQuery({
    queryKey: ["all-chat", limit],
    queryFn: () => api.getAllChat(limit),
    refetchInterval: 5_000,
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

export function useConversation(conversationId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: ["conversation", conversationId, limit],
    queryFn: () => api.getConversation(conversationId ?? "", limit),
    enabled: Boolean(conversationId),
  });
}

export function useCollaborationView(conversationId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: ["collaboration-chat", conversationId, limit],
    queryFn: () => api.getCollaborationView(conversationId ?? "", limit),
    enabled: Boolean(conversationId),
  });
}

export function useAgents(projectId: string | undefined) {
  return useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.listAgents(projectId ?? ""),
    enabled: Boolean(projectId),
    // Managed agents can be created or cascade-deleted by another agent. Poll
    // the roster so hierarchy, authorship, counts, and statuses stay coherent
    // without requiring a page refresh.
    refetchInterval: 4000,
  });
}
export function useAgentPresets(projectId: string | undefined) {
  return useQuery({ queryKey: ["agent-presets", projectId], queryFn: () => api.listAgentPresets(projectId ?? ""), enabled: Boolean(projectId) });
}

export function useAgent(agentId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: ["agent", agentId, limit],
    queryFn: () => api.getAgent(agentId ?? "", limit),
    enabled: Boolean(agentId),
  });
}

export function useEngines() {
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => api.listEngines(),
  });
}
