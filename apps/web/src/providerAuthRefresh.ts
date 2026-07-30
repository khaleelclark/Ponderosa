import type { EngineDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./queryKeys";

export async function recheckProvider(
  queryClient: QueryClient,
  engineId: string,
): Promise<EngineDto> {
  const previous = queryClient
    .getQueryData<EngineDto[]>(queryKeys.engines.all)
    ?.find(candidate => candidate.id === engineId);
  const updated = await api.recheckEngine(engineId);
  queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, current =>
    current?.map(candidate =>
      candidate.id === updated.id ? updated : candidate,
    ),
  );
  const becameOperational =
    (previous?.authenticated === false && updated.authenticated) ||
    (previous?.available === false && updated.available);
  const statusChanged =
    previous?.authenticated !== updated.authenticated ||
    previous?.available !== updated.available;
  await Promise.all([
    ...(becameOperational
      ? [
          queryClient.invalidateQueries({ queryKey: ["engine-models"] }),
          queryClient.invalidateQueries({ queryKey: ["engine-capabilities"] }),
        ]
      : []),
    ...(statusChanged
      ? [queryClient.invalidateQueries({ queryKey: queryKeys.readiness.all })]
      : []),
  ]);
  return updated;
}
