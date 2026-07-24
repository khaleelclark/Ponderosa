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
