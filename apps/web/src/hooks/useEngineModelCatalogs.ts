import { useEffect } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { EngineDto, ProjectEngineModelCatalogDto } from "@ponderosa/core";
import { api } from "../api";
import { engineCanDiscover } from "../conversationEngine";
import { queryKeys } from "../queryKeys";

const combine = (results: UseQueryResult<ProjectEngineModelCatalogDto>[]) => ({
  catalogs: results.flatMap(result => result.data ? [result.data] : []),
  isLoading: results.some(result => result.isLoading),
});

/** The same provider-owned inventory feeds composer and settings selectors. */
export function useEngineModelCatalogs(projectId: string | undefined, engines: EngineDto[]) {
  const queryClient = useQueryClient();
  const needsRefresh = (engine: EngineDto, catalog: ProjectEngineModelCatalogDto | undefined) => Boolean(catalog &&
    ((engine.cliVersion && catalog.cliVersion !== engine.cliVersion) ||
      (engine.modelCatalogFetchedAt && catalog.fetchedAt < engine.modelCatalogFetchedAt)));
  const result = useQueries({ queries: engines.filter(engine => engine.modelDiscovery).map(engine => ({
    queryKey: queryKeys.engines.models(projectId, engine.id),
    queryFn: () => api.getEngineModels(projectId!, engine.id, needsRefresh(engine,
      queryClient.getQueryData(queryKeys.engines.models(projectId, engine.id)))),
    enabled: Boolean(projectId) && engineCanDiscover(engine),
    staleTime: 5 * 60_000,
  })), combine });
  // Ignore unrelated status samples, but revisit inventory arriving after a
  // CLI change. Query's structural sharing keeps failed refreshes from looping.
  const identity = JSON.stringify(engines.map(engine => [engine.id, engine.installed, engine.enabled,
    engine.authentication, engine.cliVersion, engine.modelCatalogFetchedAt]));
  useEffect(() => {
    for (const engine of engines) {
      const queryKey = queryKeys.engines.models(projectId, engine.id);
      if (projectId && engineCanDiscover(engine) && needsRefresh(engine, queryClient.getQueryData(queryKey))) {
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      }
    }
  }, [identity, projectId, queryClient, result.catalogs]);
  return result;
}
