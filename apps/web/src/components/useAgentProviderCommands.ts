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
    onNotice(
      result.message ??
        `/${command.name} invoked through ${engine?.displayName ?? "the provider"}.`,
    );
  };
  return {
    invokeAgentCommand,
    providerUsageState,
    setProviderUsageState,
  };
}
