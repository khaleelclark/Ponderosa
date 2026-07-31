import type {
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryPageDto,
} from "@ponderosa/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

export const WORKSPACE_DIRECTORY_PAGE_SIZE = 25;

export function useWorkspaceDirectory<T extends WorkspaceDirectoryItemDto>(
  kind: WorkspaceDirectoryKind,
  options: {
    search?: string;
    projectId?: string;
    agentIds?: readonly string[];
    conversationId?: string;
    preferenceRevision: string;
    enabled?: boolean;
  },
) {
  const search = options.search?.trim() ?? "";
  return useInfiniteQuery({
    queryKey: queryKeys.workspaceDirectory.list(
      kind,
      search,
      options.projectId,
      options.agentIds?.join(","),
      options.conversationId,
      options.preferenceRevision,
    ),
    queryFn: ({ pageParam }) =>
      api.getWorkspaceDirectory<T>(kind, {
        limit: WORKSPACE_DIRECTORY_PAGE_SIZE,
        cursor: pageParam,
        search: search || undefined,
        projectId: options.projectId,
        agentIds: options.agentIds?.join(","),
        conversationId: options.conversationId,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (
      lastPage: WorkspaceDirectoryPageDto<T>,
    ) => lastPage.history.cursor,
    enabled: options.enabled ?? true,
  });
}

export function workspaceDirectoryItems<T extends WorkspaceDirectoryItemDto>(
  pages: readonly WorkspaceDirectoryPageDto<T>[] | undefined,
): {
  starredItems: T[];
  items: T[];
  total: number;
} {
  if (!pages?.length) return { starredItems: [], items: [], total: 0 };
  const latest = pages[pages.length - 1]!;
  const starredItems = latest.starredItems;
  const seen = new Set<string>();
  const items = pages.flatMap(page => page.items).filter(item => {
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
  return { starredItems, items, total: latest.total };
}
