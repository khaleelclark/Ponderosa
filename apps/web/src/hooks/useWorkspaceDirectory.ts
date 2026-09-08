import type {
  ProjectSort,
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryPageDto,
  WorkspacePreferencesDto,
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
  isFetchingNextPage: boolean;
  hasNextPage: boolean;

  retry(): Promise<unknown>;
  fetchNextPage(): Promise<unknown>;
}

export function combineWorkspaceDirectoryRequestStates(
  states: readonly WorkspaceDirectoryRequestState[],
): WorkspaceDirectoryRequestState {
  return {
    hasResolved: states.every(state => state.hasResolved),
    isInitialLoading: states.some(state => state.isInitialLoading),
    isRefreshing: states.some(state => state.isRefreshing),
    isInitialError: states.some(state => state.isInitialError),
    isPaginationError: states.some(state => state.isPaginationError),
    isFetchingNextPage: states.some(state => state.isFetchingNextPage),
    hasNextPage: states.some(state => state.hasNextPage),
    retry: () => Promise.all(states.map(state => state.retry())),
    fetchNextPage: () => Promise.all(states.filter(state => state.isPaginationError || state.hasNextPage).map(state => state.fetchNextPage())),
  };
}

export function useWorkspaceDirectory<T extends WorkspaceDirectoryItemDto>(
  kind: WorkspaceDirectoryKind,
  options: {
    search?: string;
    projectId?: string;
    agentIds?: readonly string[];
    conversationId?: string;
    sort?: ProjectSort | "next_fire";
    active?: boolean;
    onlyEnabled?: boolean;
    enabled?: boolean;
    retainPreviousData?: boolean;
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
  const queryKey = queryKeys.workspaceDirectory.list(
    kind,
    search,
    options.projectId,
    options.agentIds?.join(","),
    options.conversationId,
    options.sort,
    options.active,
    options.onlyEnabled,
  );
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
        enabled: options.onlyEnabled,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (
      lastPage: WorkspaceDirectoryPageDto<T>,
    ) => lastPage.history.cursor,
    enabled: options.enabled ?? true,
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
      isFetchingNextPage: query.isFetchingNextPage,
      hasNextPage: Boolean(
        !query.isPlaceholderData && query.hasNextPage,
      ),
      retry: query.refetch,
      fetchNextPage: query.fetchNextPage,
    } satisfies WorkspaceDirectoryRequestState,
  };
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
            : item.trigger.id;
    if (seen.has(id)) return false;
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
          : item.trigger.id;
    return stars.has(resourcePreferenceKey(item.kind, id));
  };
  const starredItems = allItems.filter(isStarred);
  const items = allItems.filter(item => !isStarred(item));
  return { starredItems, items, total: latest.total };
}
