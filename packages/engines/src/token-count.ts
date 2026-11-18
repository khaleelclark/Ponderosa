/** Provider counters are exact nonnegative integers, never estimates. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Missing components and integer overflow must not become a displayed total. */
export function tokenSum(...values: (number | undefined)[]): number | undefined {
  if (values.some(value => value === undefined)) return undefined;
  return tokenCount(values.reduce<number>((sum, value) => sum + value!, 0));
}
