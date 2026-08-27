import type {
  AgentDetailDto,
  AgentDto,
  ConversationDetailDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

interface AgentDetailAdministrationInput {
  agentId: string;
  organizationParentId: string;
  settingsEngine: string;
  settingsModel: string;
  settingsEffort: string;
  onRenameClosed(): void;
  onOrganizationClosed(): void;
  onRuntimeSettingsNotice(value?: string): void;
}

interface AgentRuntimeSettingsPatch {
  activeEngine: string;
  model: string | null;
  effort: string | null;
}

export function useAgentDetailAdministration({
  agentId,
  organizationParentId,
  settingsEngine,
  settingsModel,
  settingsEffort,
  onRenameClosed,
  onOrganizationClosed,
  onRuntimeSettingsNotice,
}: AgentDetailAdministrationInput) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (title: string) => api.updateAgent(agentId, { title }),
    onSuccess: updated => {
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(agentId) },
        current => (current ? { ...current, agent: updated } : current),
      );
      queryClient.setQueriesData<AgentDto[]>(
        { queryKey: queryKeys.agents.all },
        current =>
          current?.map(agent => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueriesData<ConversationDetailDto>(
        { queryKey: queryKeys.conversations.detailAll },
        current =>
          current
            ? {
                ...current,
                agents: current.agents.map(agent =>
                  agent.id === updated.id ? updated : agent,
                ),
              }
            : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(agentId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailAll,
      });
      onRenameClosed();
    },
  });

  const updateOrganization = useMutation({
    mutationFn: () =>
      api.updateAgentOrganization(agentId, {
        managerAgentId: organizationParentId || null,
      }),
    onSuccess: updated => {
      onOrganizationClosed();
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(agentId) },
        current => (current ? { ...current, agent: updated } : current),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });

  const updateManagementPermissions = useMutation({
    mutationFn: (managementPermissions: AgentDto["managementPermissions"]) =>
      api.updateAgent(agentId, { managementPermissions }),
    onSuccess: updated => {
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(agentId) },
        current => (current ? { ...current, agent: updated } : current),
      );
      queryClient.setQueriesData<AgentDto[]>(
        { queryKey: queryKeys.agents.all },
        current =>
          current?.map(agent => (agent.id === updated.id ? updated : agent)),
      );
    },
  });

  const updateRuntimeSettings = useMutation({
    mutationFn: (patch?: AgentRuntimeSettingsPatch) =>
      api.updateAgent(agentId, patch ?? {
        activeEngine: settingsEngine,
        model: settingsModel || null,
        effort: settingsEffort || null,
      }),
    onSuccess: updated => {
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(agentId) },
        current => (current ? { ...current, agent: updated } : current),
      );
      queryClient.setQueriesData<AgentDto[]>(
        { queryKey: queryKeys.agents.all },
        current =>
          current?.map(agent => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueriesData<ConversationDetailDto>(
        { queryKey: queryKeys.conversations.detailAll },
        current =>
          current
            ? {
                ...current,
                agents: current.agents.map(agent =>
                  agent.id === updated.id ? updated : agent,
                ),
              }
            : current,
      );
      onRuntimeSettingsNotice(
        "Saved. These runtime settings apply when the next Run starts.",
      );
    },
    onError: () => onRuntimeSettingsNotice(undefined),
  });

  return {
    rename,
    updateManagementPermissions,
    updateOrganization,
    updateRuntimeSettings,
  };
}
