/** Remove transient empty slots from API/query-cache collections. */
export function compactDefined<T>(values: readonly (T | null | undefined)[]): T[] {
  return values.filter((value): value is T => value != null);
}
