import type {
  ProjectSort,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryPageDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
} from "@ponderosa/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { normalizeResetPages } from "../collections";
import {
  resourcePreferenceKey,
  starredWorkspaceResources,
} from "../resourcePreferences";
import { sameWorkspaceDirectoryScope } from "../workspaceDirectoryScope.js";

export const WORKSPACE_DIRECTORY_PAGE_SIZE = 25;

export interface WorkspaceDirectoryRequestState {
  hasResolved: boolean;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isInitialError: boolean;
  isPaginationError: boolean;
  isRefreshError?: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;

  retry(): Promise<unknown>;
  fetchNextPage(): Promise<unknown>;
}

export function useWorkspaceDirectory<T extends WorkspaceDirectoryItemDto>(
  kind: WorkspaceDirectoryKind,
  options: {
    search?: string;
    projectId?: string;
    agentIds?: readonly string[];
    conversationId?: string;
    sort?: ProjectSort;
    active?: boolean;
    recentOutcomes?: boolean;
    enabled?: boolean;
    retainPreviousData?: boolean;
    summary?: boolean;
    /** Sidebar-only complete saved folder metadata; general lists remain bounded. */
    folders?: boolean;
    /** Isolate a bounded picker window from complete management collections. */
    maxPages?: number;
  },
) {
  const requestedSearch = options.search?.trim() ?? "";
  const [search, setSearch] = useState(requestedSearch);
  useEffect(() => {
    if (!requestedSearch) {
      setSearch("");
      return;
    }
    const timer = globalThis.setTimeout(() => setSearch(requestedSearch), 250);
    return () => globalThis.clearTimeout(timer);
  }, [requestedSearch]);
  const queryKey = [...queryKeys.workspaceDirectory.list(
    kind,
    search,
    options.projectId,
    options.agentIds?.join(","),
    options.conversationId,
    options.sort,
    options.active,
    options.recentOutcomes,
    options.summary,
  ), ...(options.folders || options.maxPages !== undefined ? [options.maxPages] : []),
    ...(options.folders ? ["folders"] : [])] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      api.getWorkspaceDirectory<T>(kind, {
        limit: WORKSPACE_DIRECTORY_PAGE_SIZE,
        cursor: pageParam as string | undefined,
        search: search || undefined,
        projectId: options.projectId,
        agentIds: options.agentIds?.join(","),
        conversationId: options.conversationId,
        sort: options.sort,
        active: options.active,
        outcomes: options.recentOutcomes,
        summary: options.summary,
        folders: options.folders,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (
      lastPage: WorkspaceDirectoryPageDto<T>,
    ) => lastPage.history.cursor,
    enabled: options.enabled ?? true,
    maxPages: options.maxPages,
    ...(options.retainPreviousData === false
      ? {}
      : {
          placeholderData: (previousData, previousQuery) =>
            sameWorkspaceDirectoryScope(previousQuery?.queryKey, queryKey)
              ? previousData
              : undefined,
        }),
    select: normalizeResetPages,
    staleTime: 5_000,
  });
  const hasResolved = Boolean(query.data);
  return {
    data: query.data,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.isPlaceholderData ? false : query.hasNextPage,
    isError: query.isError,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading,
    requestState: {
      hasResolved,
      isInitialLoading: !hasResolved && query.isPending,
      isRefreshing:
        hasResolved && query.isFetching && !query.isFetchingNextPage,
      isInitialError: !hasResolved && query.isError,
      isPaginationError: hasResolved && query.isFetchNextPageError,
      isRefreshError: hasResolved && query.isRefetchError && !query.isFetchNextPageError,
      isFetchingNextPage: query.isFetchingNextPage,
      hasNextPage: Boolean(
        !query.isPlaceholderData && query.hasNextPage,
      ),
      retry: () => query.refetch({ cancelRefetch: false }),
      fetchNextPage: query.fetchNextPage,
    } satisfies WorkspaceDirectoryRequestState,
  };
}

/** The rail shows every Project, not only the first bounded directory page. */
export function useProjectRailDirectory() {
  const query = useWorkspaceDirectory<WorkspaceProjectDirectoryItemDto>("project", { search: "", enabled: true });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isError) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.isError, query.fetchNextPage]);
  return query;
}

export function workspaceDirectoryItems<T extends WorkspaceDirectoryItemDto>(
  pages: readonly WorkspaceDirectoryPageDto<T>[] | undefined,
  preferences: WorkspacePreferencesDto,
): {
  starredItems: T[];
  items: T[];
  total: number;
} {
  if (!pages?.length) return { starredItems: [], items: [], total: 0 };
  const latest = pages[pages.length - 1]!;
  const seen = new Set<string>();
  const allItems = [
    ...pages[0]!.starredItems,
    ...pages.flatMap(page => page.items),
  ].filter(item => {
    const id =
      item.kind === "project"
        ? item.project.id
        : item.kind === "conversation"
          ? item.conversation.id
          : item.kind === "agent"
            ? item.agent.id
            : undefined;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const stars = starredWorkspaceResources(preferences);
  const isStarred = (item: T) => {
    const id = item.kind === "project"
      ? item.project.id
      : item.kind === "conversation"
        ? item.conversation.id
        : item.kind === "agent"
          ? item.agent.id
          : undefined;
    return id !== undefined && (item.kind === "project" || item.kind === "conversation" || item.kind === "agent") && stars.has(resourcePreferenceKey(item.kind, id));
  };
  const starredItems = allItems.filter(isStarred);
  const items = allItems.filter(item => !isStarred(item));
  return { starredItems, items, total: latest.total };
}
