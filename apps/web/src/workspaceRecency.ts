import type {
  WorkspaceResourceKind,
  WorkspaceResourceRecencyDto,
  WorkspaceResourceRecencyListDto,
} from "@ponderosa/core";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./queryKeys";
import type { Route } from "./routing";

export function workspaceResourceKey(
  kind: WorkspaceResourceKind,
  resourceId: string,
): `${WorkspaceResourceKind}:${string}` {
  return `${kind}:${resourceId}`;
}

export function workspaceResourceRecencyMap(
  recency: WorkspaceResourceRecencyListDto | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    (recency?.resources ?? []).map(item => [item.resourceKey, item.lastUsedAt]),
  );
}

export function useWorkspaceResourceRecency() {
  return useQuery({
    queryKey: queryKeys.workspaceResourceRecency.all,
    queryFn: () => api.getWorkspaceResourceRecency(),
    staleTime: 5_000,
  });
}

export function workspaceResourceFromRoute(
  route: Route,
): { kind: WorkspaceResourceKind; resourceId: string } | undefined {
  if (route.kind === "project") {
    return { kind: "project", resourceId: route.projectId };
  }
  if (route.kind === "conversation") {
    return { kind: "conversation", resourceId: route.conversationId };
  }
  if (route.kind === "agent" && route.view !== "triggers") {
    return { kind: "agent", resourceId: route.agentId };
  }
  return undefined;
}

export function markWorkspaceResourceUsed(
  queryClient: QueryClient,
  kind: WorkspaceResourceKind,
  resourceId: string,
): void {
  const optimistic: WorkspaceResourceRecencyDto = {
    resourceKey: workspaceResourceKey(kind, resourceId),
    kind,
    resourceId,
    lastUsedAt: new Date().toISOString(),
  };
  const apply = (entry: WorkspaceResourceRecencyDto) => {
    queryClient.setQueryData<WorkspaceResourceRecencyListDto>(
      queryKeys.workspaceResourceRecency.all,
      current => ({
        resources: [
          entry,
          ...(current?.resources ?? []).filter(
            item => item.resourceKey !== entry.resourceKey,
          ),
        ],
      }),
    );
  };
  apply(optimistic);
  void api.markWorkspaceResourceUsed({ kind, resourceId }).then(apply).catch(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workspaceResourceRecency.all,
    });
  });
}
