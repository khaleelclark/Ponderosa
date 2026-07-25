export interface CursorReconciliation {
  cursor: number;
  duplicate: boolean;
  gap: boolean;
}

/** Reconcile one monotonically increasing event cursor without retaining IDs. */
export function reconcileCursor<T>(
  current: number,
  next: T,
  extractId: (value: T) => number,
): CursorReconciliation {
  const cursor = extractId(next);
  if (cursor <= current) {
    return { cursor: current, duplicate: true, gap: false };
  }
  return {
    cursor,
    duplicate: false,
    gap: cursor !== current + 1,
  };
}
