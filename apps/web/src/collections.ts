/** Remove transient empty slots from API/query-cache collections. */
export function compactDefined<T>(values: readonly (T | null | undefined)[]): T[] {
  return values.filter((value): value is T => value != null);
}

/** Deduplicate by stable identity, retaining the last value and first-seen order. */
export function uniqueBy<T, Key>(
  values: readonly T[],
  key: (value: T) => Key,
  compare?: (left: T, right: T) => number,
): T[] {
  const unique = [...new Map(values.map((value) => [key(value), value] as const)).values()];
  return compare ? unique.sort(compare) : unique;
}

/** Drop pre-reset infinite-query pages after a live collection invalidates its cursor. */
export function normalizeResetPages<T extends { reset?: boolean }>(data: {
  pages: T[];
  pageParams: unknown[];
}): typeof data {
  let resetIndex = -1;
  data.pages.forEach((page, index) => { if (page.reset) resetIndex = index; });
  if (resetIndex <= 0) return data;
  return {
    ...data,
    pages: data.pages.slice(resetIndex),
    pageParams: data.pageParams.slice(resetIndex),
  };
}
