import type { BranchHomeDto, BranchHomeExecutionDto } from "@ponderosa/core";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "../api/real";
import { queryKeys } from "../queryKeys";

export function branchHomeItems(pages: BranchHomeDto[] | undefined, section: "activeExecutions" | "recentOutcomes"): BranchHomeExecutionDto[] {
  const rows = new Map<string, BranchHomeExecutionDto>();
  for (const page of pages ?? []) for (const row of page[section].items) if (!rows.has(row.id)) rows.set(row.id, row);
  return [...rows.values()];
}

/** Both sections share one initial snapshot, then page independently. */
export function useBranchHome() {
  const client = useQueryClient();
  const first = () => client.fetchQuery({ queryKey: queryKeys.branchesHome.snapshot,
    queryFn: () => requestJson<BranchHomeDto>("/api/branches/home"), staleTime: 1_000 });
  const active = useInfiniteQuery({
    queryKey: queryKeys.branchesHome.section("active"), initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => pageParam ? requestJson<BranchHomeDto>(`/api/branches/home?activeCursor=${encodeURIComponent(pageParam)}`) : first(),
    getNextPageParam: page => page.activeExecutions.nextCursor, refetchInterval: 5_000, staleTime: 5_000,
  });
  const outcomes = useInfiniteQuery({
    queryKey: queryKeys.branchesHome.section("outcomes"), initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => pageParam ? requestJson<BranchHomeDto>(`/api/branches/home?outcomeCursor=${encodeURIComponent(pageParam)}`) : first(),
    getNextPageParam: page => page.recentOutcomes.nextCursor, refetchInterval: 5_000, staleTime: 5_000,
  });
  const snapshots = [active.data?.pages[0], outcomes.data?.pages[0]].filter((page): page is BranchHomeDto => Boolean(page));
  return { data: snapshots.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0], active, outcomes };
}
