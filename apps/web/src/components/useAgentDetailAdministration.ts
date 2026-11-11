import {createClientId} from "../clientId";
import {productApiPath} from "../api/productScope";
import type {
  AgentDetailDto,
  AgentDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runtimeMutationOptions, runtimeFeedbackKey } from "../hooks/useRuntimeControls";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { publishUpdatedAgent, refreshAgentRuntime, replaceCachedConversationAgent } from "../conversationAgentCache";
import { useMutationNotification } from "./MutationNotifications";

interface AgentDetailAdministrationInput {
  agentId: string;
  organizationParentId: string;
  settingsEngine: string;
  settingsModel: string;
  settingsEffort: string;
  onRenameClosed(): void;
  onOrganizationClosed(): void;
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
}: AgentDetailAdministrationInput) {
  const queryClient = useQueryClient();
  const notify = useMutationNotification();
  const runtimeNamespace=productApiPath("/api/conversations");
  const namespace=productApiPath("/api/agents");
  const key=(operation:string,owner=agentId)=>JSON.stringify([namespace,owner,operation]);
  const failed=(operation:string,title:string,error:unknown)=>notify({key:key(operation),incident:createClientId("agent-feedback-"),severity:"error",message:title,description:"Your original Agent settings remain available for review.",details:error instanceof Error?error.message:String(error)});
  const rename = useMutation({
    mutationKey:["agent-rename",namespace,agentId],
    onError:error=>failed("rename","Agent Name Not Saved",error),
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
      notify({ key: key("rename",updated.id), message: `Agent renamed to ${updated.title}.` });
    },
  });

  const updateOrganization = useMutation({
    mutationKey:["agent-organization",namespace,agentId],
    onError:error=>failed("organization","Reporting Line Not Saved",error),
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
      notify({ key: key("organization",updated.id), message: "Agent reporting relationship updated." });
    },
  });

  const updateManagementPermissions = useMutation({
    mutationKey:["agent-permissions",namespace,agentId],
    onError:error=>failed("permissions","Permissions Not Saved",error),
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
      notify({ key: key("permissions",updated.id), message: "Settings Saved" });
    },
  });

  const updateRuntimeSettings = useMutation({
    ...runtimeMutationOptions(`agent:${agentId}`,notify),
    mutationFn: ({ agentId, patch }: { agentId: string; patch: AgentRuntimeSettingsPatch; manual: boolean }) =>
      api.updateAgent(agentId, patch),
    onSuccess: (updated, variables) => {
      notify({key:runtimeFeedbackKey(`agent:${updated.id}`,runtimeNamespace),message:"",dismiss:true});
      publishUpdatedAgent(queryClient, updated);
      if (variables.manual) notify({ key: `agent-runtime:${updated.id}`, message: "Settings Saved" });
    },
    onSettled: (_updated, _error, variables) => refreshAgentRuntime(queryClient, variables.agentId),
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
