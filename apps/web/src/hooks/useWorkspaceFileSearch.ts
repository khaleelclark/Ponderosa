import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import { uniqueBy } from "../collections";

export function useWorkspaceFileSearch(
  query: string,
  enabled: boolean,
  scopeKey: string,
  scope?: { projectId: string; conversationId?: string },
) {
  const search = useInfiniteQuery({
    queryKey: ["workspace-file-search", query, scopeKey, scope?.projectId, scope?.conversationId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.searchGlobalFiles(query, 25, scope, pageParam, signal),
    getNextPageParam: page => page.nextCursor,
    enabled,
    staleTime: 5_000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const pages = search.data?.pages ?? [];
  return {
    ...search,
    results: uniqueBy(pages.flatMap(page => page.results), file => `${file.project.id}\u0000${file.conversationId}\u0000${file.path}`),
    truncated: pages.some(page => page.truncated),
    unavailableRoots: pages.some(page => page.unavailableRoots > 0),
  };
}
