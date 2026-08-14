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
    (previous?.authentication !== "authenticated" && updated.authentication === "authenticated") ||
    (previous?.intakeReady === false && updated.intakeReady) ||
    (previous?.reachability !== "reachable" && updated.reachability === "reachable");
  const statusChanged =
    previous?.authentication !== updated.authentication ||
    previous?.intakeReady !== updated.intakeReady ||
    previous?.reachability !== updated.reachability;
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
