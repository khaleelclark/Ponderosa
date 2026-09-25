import type {
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
} from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys.js";

export function providerUsageRefreshInterval(
  center: ProviderUsageCenterDto | undefined,
): 5_000 | false {
  return center?.providers.some(provider => provider.refreshing) ? 5_000 : false;
}

export function mergeProviderUsage(
  center: ProviderUsageCenterDto | undefined,
  state: ProviderUsageStateDto,
): ProviderUsageCenterDto {
  const providers = center?.providers ?? [];
  const index = providers.findIndex(candidate =>
    candidate.provider === state.provider);
  return {
    providers: index < 0
      ? [...providers, state]
      : providers.map((candidate, candidateIndex) =>
          candidateIndex === index ? state : candidate),
  };
}

/** Replace any older in-flight read before publishing an explicit refresh. */
export async function loadLatestProviderUsage(
  queryClient: QueryClient,
  load: () => Promise<ProviderUsageCenterDto>,
): Promise<ProviderUsageCenterDto> {
  const filter = { queryKey: queryKeys.providerUsage.all } as const;
  await queryClient.cancelQueries(filter);
  const state = await queryClient.fetchQuery({
    queryKey: queryKeys.providerUsage.all,
    queryFn: load,
    staleTime: 0,
  });
  await queryClient.cancelQueries(filter);
  queryClient.setQueryData(queryKeys.providerUsage.all, state);
  return state;
}

export async function refreshLatestProviderUsage(
  queryClient: QueryClient,
  refresh: () => Promise<ProviderUsageStateDto>,
): Promise<ProviderUsageStateDto> {
  const filter = { queryKey: queryKeys.providerUsage.all } as const;
  await queryClient.cancelQueries(filter);
  const state = await refresh();
  // Fence a focus/reconnect read that may have started while the provider
  // operation was running before publishing its newer state.
  await queryClient.cancelQueries(filter);
  queryClient.setQueryData<ProviderUsageCenterDto>(
    queryKeys.providerUsage.all,
    current => mergeProviderUsage(current, state),
  );
  return state;
}

export async function refreshLatestAgentProviderUsage(
  queryClient: QueryClient,
  agentId: string,
  refresh: () => Promise<ProviderUsageStateDto>,
): Promise<ProviderUsageStateDto> {
  const agentFilter = {
    queryKey: queryKeys.providerUsage.agent(agentId),
    exact: true,
  } as const;
  await queryClient.cancelQueries(agentFilter);
  const state = await refreshLatestProviderUsage(queryClient, refresh);
  await queryClient.cancelQueries(agentFilter);
  queryClient.setQueryData(queryKeys.providerUsage.agent(agentId), state);
  return state;
}
