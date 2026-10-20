import type {
  AgentDetailDto,
  AgentDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { runtimeMutationOptions } from "../hooks/useRuntimeControls";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { replaceCachedConversationAgent } from "../conversationAgentCache";
import { useMutationNotification } from "./MutationNotifications";

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
  speed?: string | null;
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
  const notify = useMutationNotification();
  const currentAgentId = useRef(agentId);
  currentAgentId.current = agentId;
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
      queryClient.setQueriesData<unknown>(
        { queryKey: queryKeys.conversations.detailAll },
        (current: unknown) => replaceCachedConversationAgent(current, updated),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(agentId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailAll,
      });
      onRenameClosed();
      notify({ key: `agent-renamed:${agentId}`, message: `Agent renamed to ${updated.title}.` });
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
      notify({ key: `agent-organization:${agentId}`, message: "Agent reporting relationship updated." });
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
      notify({ key: `agent-permissions:${agentId}`, message: "Agent permissions saved." });
    },
  });

  const updateRuntimeSettings = useMutation({
    ...runtimeMutationOptions(`agent:${agentId}`),
    mutationFn: ({ agentId, patch }: { agentId: string; patch: AgentRuntimeSettingsPatch; manual: boolean }) =>
      api.updateAgent(agentId, patch),
    onSuccess: (updated, variables) => {
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(updated.id) },
        current => (current ? { ...current, agent: updated } : current),
      );
      queryClient.setQueriesData<AgentDto[]>(
        { queryKey: queryKeys.agents.all },
        current =>
          current?.map(agent => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueriesData<unknown>(
        { queryKey: queryKeys.conversations.detailAll },
        (current: unknown) => replaceCachedConversationAgent(current, updated),
      );
      if (currentAgentId.current === variables.agentId) {
        onRuntimeSettingsNotice(
          variables.manual ? "Saved. These runtime settings apply when the next Run starts." : undefined,
        );
      }
      if (variables.manual) notify({ key: `agent-runtime:${updated.id}`, message: "Agent defaults saved." });
    },
    onError: (_error, variables) => {
      if (currentAgentId.current === variables.agentId) {
        onRuntimeSettingsNotice(undefined);
      }
    },
    onSettled: (_updated, _error, variables) => queryClient.invalidateQueries({
      queryKey: queryKeys.agents.detailPrefix(variables.agentId),
    }),
  });

  return {
    rename,
    updateManagementPermissions,
    updateOrganization,
    updateRuntimeSettings: {
      ...updateRuntimeSettings,
      mutate: (patch?: AgentRuntimeSettingsPatch) => updateRuntimeSettings.mutate({
        agentId,
        patch: patch ?? { activeEngine: settingsEngine, model: settingsModel || null, effort: settingsEffort || null },
        manual: patch === undefined,
      }),
    },
  };
}
