import type { Query, QueryClient } from "@tanstack/react-query";

export interface PhaseQueryBoundary {
  query: Query;
  /** TanStack's stable identity for the request active at the event boundary. */
  request?: Promise<unknown>;
  fetchStatus: Query["state"]["fetchStatus"];
  dataUpdatedAt: number;
  dataUpdateCount: number;
}

export function capturePhaseQueryBoundaries(
  queries: readonly Query[],
): ReadonlyMap<Query, PhaseQueryBoundary> {
  return new Map(queries.map(query => [query, {
    query,
    request: query.promise,
    fetchStatus: query.state.fetchStatus,
    dataUpdatedAt: query.state.dataUpdatedAt,
    dataUpdateCount: query.state.dataUpdateCount,
  }]));
}

function isCurrentActiveQuery(queryClient: QueryClient, query: Query): boolean {
  return query.isActive()
    && queryClient.getQueryCache().find({
      queryKey: query.queryKey,
      exact: true,
    }) === query;
}

async function drainFetch(
  query: Query,
  request: Promise<unknown> | undefined,
  isCurrent: () => boolean,
): Promise<boolean> {
  let pending = request;
  while (pending) {
    try {
      await pending;
    } catch {
      // A failed pre-boundary request proves nothing. A distinct fetch below
      // must still succeed before phase evidence can become visible.
    }
    if (!isCurrent()) return false;
    pending = query.state.fetchStatus === "idle"
      ? undefined
      : query.promise;
    if (pending === request) return false;
    request = pending;
  }
  return query.state.fetchStatus === "idle";
}

interface StartedPhaseFetch {
  query: Query;
  request: Promise<unknown>;
  previousRequest?: Promise<unknown>;
  previousDataUpdateCount: number;
}

/**
 * Drain requests that already existed at a phase-changing event boundary, then
 * start and verify one distinct canonical fetch for every currently active
 * phase-bearing query. The caller supplies a generation fence so completions
 * from an older event can never certify a newer one.
 */
export async function reconcilePhaseQueriesAfterBoundary(
  queryClient: QueryClient,
  queries: readonly Query[],
  boundaries: ReadonlyMap<Query, PhaseQueryBoundary>,
  isCurrentGeneration: () => boolean,
): Promise<boolean> {
  if (!queries.length) return isCurrentGeneration();

  const drained = await Promise.all(queries.map(async query => {
    const boundary = boundaries.get(query) ?? capturePhaseQueryBoundaries([query]).get(query);
    return boundary
      ? drainFetch(
          query,
          boundary.fetchStatus === "idle" ? undefined : boundary.request,
          () => isCurrentGeneration() && isCurrentActiveQuery(queryClient, query),
        )
      : false;
  }));
  if (!drained.every(Boolean) || !isCurrentGeneration()) return false;
  if (queries.some(query => !isCurrentActiveQuery(queryClient, query))) return false;

  const started: StartedPhaseFetch[] = [];
  const completions: Promise<void>[] = [];
  let failedToStart = false;
  for (const query of queries) {
    const previousRequest = query.promise;
    const previousDataUpdateCount = query.state.dataUpdateCount;
    // Invalidation remains canonical, but refetchType:none prevents it from
    // racing the explicit post-boundary fetch in the same JavaScript turn.
    void queryClient.invalidateQueries({
      queryKey: query.queryKey,
      exact: true,
      refetchType: "none",
    });
    const completion = queryClient.refetchQueries({
      queryKey: query.queryKey,
      exact: true,
      type: "active",
    }, {
      cancelRefetch: false,
      throwOnError: true,
    });
    completions.push(completion);
    const request = query.promise;
    if (!request || request === previousRequest) {
      failedToStart = true;
      continue;
    }
    started.push({
      query,
      request,
      previousRequest,
      previousDataUpdateCount,
    });
  }

  await Promise.all(completions);
  return !failedToStart && isCurrentGeneration() && started.every(fetch => (
    isCurrentActiveQuery(queryClient, fetch.query)
    && fetch.query.promise === fetch.request
    && fetch.request !== fetch.previousRequest
    && fetch.query.state.fetchStatus === "idle"
    && fetch.query.state.status === "success"
    && fetch.query.state.dataUpdateCount > fetch.previousDataUpdateCount
  ));
}
