import type {
  AgentOperationalStatus,
  AgentOrganizationPageDto,
  AgentOrganizationScope,
} from "@ponderosa/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import { mergeOrganizationPages } from "../agentOrganization";
import { normalizeResetPages } from "../collections";
import { queryKeys } from "../queryKeys";

export const AGENT_ORGANIZATION_PAGE_SIZE = 25;

export function useAgentOrganization(
  projectId: string,
  options: {
    scope: AgentOrganizationScope;
    parentAgentId?: string;
    search?: string;
    status?: AgentOperationalStatus;
    enabled?: boolean;
  },
) {
  const search = options.search?.trim() ?? "";
  const query = useInfiniteQuery({
    queryKey: queryKeys.agents.organizationPage(
      projectId,
      options.scope,
      options.parentAgentId,
      search,
      options.status,
    ),
    queryFn: ({ pageParam, signal }) => api.getAgentOrganizationPage(
      projectId,
      {
        scope: options.scope,
        parentAgentId: options.parentAgentId,
        limit: AGENT_ORGANIZATION_PAGE_SIZE,
        cursor: pageParam,
        search: search || undefined,
        status: options.status,
      },
      signal,
    ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: options.enabled ?? true,
    select: normalizeResetPages,
    staleTime: 5_000,
  });
  const pages = query.data?.pages as AgentOrganizationPageDto[] | undefined;
  return {
    ...query,
    pages,
    items: mergeOrganizationPages(pages),
    summary: pages?.at(-1),
  };
}
