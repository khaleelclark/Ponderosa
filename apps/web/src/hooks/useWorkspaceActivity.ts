import { useQuery } from "@tanstack/react-query";
import type { ChatFolderDto, WorkspaceActivityProjectionDto } from "@ponderosa/core";
import { queryKeys } from "../queryKeys";
import { requestJson } from "../api/real";

/** Scope changes cannot reuse a previous folder's counts. SSE directory
 * invalidation and a visible-only fallback refresh share this query identity. */
export function useWorkspaceActivity(conversationIds: string[], folders: ChatFolderDto[], enabled: boolean) {
  const ids = [...new Set(conversationIds)].sort();
  const groups = folders.map(folder => ({ id: folder.id, conversationIds: [...new Set(folder.conversationIds)].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return useQuery({
    queryKey: [...queryKeys.workspaceDirectory.list("agent", "", undefined, JSON.stringify(ids), JSON.stringify(groups), undefined, undefined, undefined, true), "activity"],
    enabled,
    staleTime: 10_000,
    refetchInterval: enabled ? 5_000 : false,
    queryFn: async ({ signal }): Promise<WorkspaceActivityProjectionDto> => {
      const result: WorkspaceActivityProjectionDto = { conversations: {}, chatFolders: {} };
      const batches = Math.max(Math.ceil(ids.length / 200), Math.ceil(groups.length / 200), 1);
      for (let index = 0; index < batches; index++) {
        const page = await requestJson<WorkspaceActivityProjectionDto>("/api/workspace/directory/activity", {
          method: "POST", signal,
          body: JSON.stringify({ conversationIds: ids.slice(index * 200, (index + 1) * 200), chatFolders: groups.slice(index * 200, (index + 1) * 200) }),
        });
        Object.assign(result.conversations, page.conversations);
        Object.assign(result.chatFolders, page.chatFolders);
      }
      return result;
    },
  });
}
