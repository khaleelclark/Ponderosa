import type {
  WorkspacePreferencesDto,
  WorkspaceResourceKind,
  WorkspaceResourceRecencyDto,
  WorkspaceResourceRecencyListDto,
} from "@ponderosa/core";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./queryKeys";
import type { Route } from "./routing";

export const WORKSPACE_RESOURCE_RECENCY_LIMIT = 100;
const OLDEST_RESOURCE_TIME = new Date(0).toISOString();

export function workspaceResourceKey(
  kind: WorkspaceResourceKind,
  resourceId: string,
): `${WorkspaceResourceKind}:${string}` {
  return `${kind}:${resourceId}`;
}

export function workspaceResourceRecencyTime(
  recency: WorkspaceResourceRecencyListDto | undefined,
  resourceKey: string,
  fallback: string,
): string {
  const item = recency?.resources.find(resource => resource.resourceKey === resourceKey);
  if (item) return item.lastUsedAt;
  return recency?.truncated ? OLDEST_RESOURCE_TIME : fallback;
}

export function boundWorkspaceResourceRecency(
  resources: readonly WorkspaceResourceRecencyDto[],
  preferences: WorkspacePreferencesDto | undefined,
  limit = WORKSPACE_RESOURCE_RECENCY_LIMIT,
): WorkspaceResourceRecencyDto[] {
  const starred = new Set([
    ...(preferences?.starredResourceIds ?? []),
    ...(preferences?.starredProjectIds ?? []).map(id => `project:${id}`),
  ]);
  let unstarredCount = 0;
  return resources.filter(resource => {
    if (starred.has(resource.resourceKey)) return true;
    if (unstarredCount >= limit) return false;
    unstarredCount += 1;
    return true;
  });
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
    const preferences = queryClient.getQueryData<WorkspacePreferencesDto>(
      queryKeys.workspacePreferences.all,
    );
    queryClient.setQueryData<WorkspaceResourceRecencyListDto>(
      queryKeys.workspaceResourceRecency.all,
      current => {
        const candidates = [
          entry,
          ...(current?.resources ?? []).filter(
            item => item.resourceKey !== entry.resourceKey,
          ),
        ];
        const resources = boundWorkspaceResourceRecency(
          candidates,
          preferences,
        );
        const truncated = Boolean(current?.truncated)
          || resources.length < candidates.length;
        return {
          resources,
          ...(truncated ? { truncated: true } : {}),
        };
      },
    );
  };
  apply(optimistic);
  void api.markWorkspaceResourceUsed({ kind, resourceId }).then(apply).catch(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workspaceResourceRecency.all,
    });
  });
}
