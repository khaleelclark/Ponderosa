import type {
  EngineCommand,
  EngineDto,
  ProviderUsageStateDto,
} from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { refreshLatestAgentProviderUsage } from "../providerUsageQuery";
import { queryKeys } from "../queryKeys";
import { useMutationNotification } from "./MutationNotifications";

export function useAgentProviderCommands({
  agentId,
  engine,
  onNotice,
}: {
  agentId: string;
  engine?: EngineDto;
  onNotice(value: string): void;
}) {
  const queryClient = useQueryClient();
  const notify = useMutationNotification();
  const [providerUsageState, setProviderUsageState] =
    useState<ProviderUsageStateDto>();
  const invokeAgentCommand = async (
    command: EngineCommand,
    argumentsText: string,
  ) => {
    if (command.name === engine?.providerUsageCommand) {
      const loading = providerUsageState
        ? { ...providerUsageState, refreshing: true }
        : undefined;
      if (!loading) {
        const next = await refreshLatestAgentProviderUsage(
          queryClient,
          agentId,
          () => api.getAgentProviderUsage(agentId, true),
        );
        setProviderUsageState(next);
        return;
      }
      setProviderUsageState(loading);
      queryClient.setQueryData(queryKeys.providerUsage.agent(agentId), loading);
      try {
        const next = await refreshLatestAgentProviderUsage(
          queryClient,
          agentId,
          () => api.getAgentProviderUsage(agentId, true),
        );
        setProviderUsageState(next);
      } catch (error) {
        const failed = { ...loading, refreshing: false };
        setProviderUsageState(failed);
        queryClient.setQueryData(
          queryKeys.providerUsage.agent(agentId),
          failed,
        );
        throw error;
      }
      return;
    }
    const result = await api.invokeProviderCommand(agentId, {
      name: command.name,
      ...(argumentsText ? { argumentsText } : {}),
    });
    if (result.outcome && result.outcome !== "completed") throw new Error(result.message ?? "Provider command completion is unconfirmed. Do not repeat the command.");
    if (result.message) onNotice(result.message);
    else notify({ key: "provider-command", message: `/${command.name} Invoked` });
  };
  return {
    invokeAgentCommand,
    providerUsageState,
    setProviderUsageState,
  };
}
