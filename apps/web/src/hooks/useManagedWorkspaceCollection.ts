import type { WorkspaceDirectoryItemDto, WorkspaceDirectoryPageDto } from "@ponderosa/core";
import { useEffect, useMemo, useState } from "react";

export function uniqueManagedRows<T extends WorkspaceDirectoryItemDto>(
  pages: readonly Pick<WorkspaceDirectoryPageDto<T>, "starredItems" | "items">[] | undefined,
  getId: (row: T) => string,
): T[] {
  if (!pages?.length) return [];
  const seen = new Set<string>();
  return [
    ...pages[0]!.starredItems,
    ...pages.flatMap(page => page.items),
  ].filter(row => {
    const id = getId(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function toggleManagedRow<T>(
  current: ReadonlyMap<string, T>,
  row: T,
  getId: (row: T) => string,
): Map<string, T> {
  const next = new Map(current);
  const id = getId(row);
  if (next.has(id)) next.delete(id);
  else next.set(id, row);
  return next;
}

export function toggleManagedVisibleRows<T>(
  current: ReadonlyMap<string, T>,
  rows: readonly T[],
  getId: (row: T) => string,
): Map<string, T> {
  const next = new Map(current);
  const allSelected = rows.length > 0 && rows.every(row => current.has(getId(row)));
  for (const row of rows) {
    const id = getId(row);
    if (allSelected) next.delete(id);
    else next.set(id, row);
  }
  return next;
}

/** Management workspaces intentionally fetch the complete matching collection
 * before offering Select all; ordinary sidebar directories remain paginated. */
export function useManagedWorkspaceCollection<T extends WorkspaceDirectoryItemDto>(
  directoryQuery: {
    data?: { pages: readonly WorkspaceDirectoryPageDto<T>[] };
    requestState: {
      hasResolved: boolean;
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      isPaginationError: boolean;
    };
    fetchNextPage: () => Promise<unknown>;
  },
  getId: (row: T) => string,
) {
  const [selected, setSelected] = useState<Map<string, T>>(() => new Map());
  const rows = useMemo(
    () => uniqueManagedRows<T>(directoryQuery.data?.pages, getId),
    [directoryQuery.data?.pages, getId],
  );
  const total = directoryQuery.data?.pages.at(-1)?.total ?? 0;
  const {
    hasResolved, hasNextPage, isFetchingNextPage, isPaginationError,
  } = directoryQuery.requestState;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isPaginationError) {
      void directoryQuery.fetchNextPage();
    }
  }, [directoryQuery.fetchNextPage, hasNextPage, isFetchingNextPage, isPaginationError]);

  const visibleSelectedCount = rows.reduce(
    (count, row) => count + Number(selected.has(getId(row))),
    0,
  );
  const allVisibleSelected = rows.length > 0 && visibleSelectedCount === rows.length;
  const collectionComplete = hasResolved && !hasNextPage && !isFetchingNextPage && !isPaginationError;
  const toggleSelected = (row: T) => setSelected(current => toggleManagedRow(current, row, getId));
  const toggleSelectAll = () => setSelected(current => toggleManagedVisibleRows(current, rows, getId));

  return {
    rows,
    total,
    selected,
    setSelected,
    visibleSelectedCount,
    allVisibleSelected,
    collectionComplete,
    toggleSelected,
    toggleSelectAll,
  };
}
