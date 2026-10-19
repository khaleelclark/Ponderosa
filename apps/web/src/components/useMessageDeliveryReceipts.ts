import type { ActiveMessageDeliveryReceiptsDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

import { projectMessageDeliveryReceipts, type ReceiptSource } from "./messageDeliveryReceipts";

const combine = (results: { data?: ActiveMessageDeliveryReceiptsDto }[]) =>
  results.flatMap(result => result.data?.items ?? []);

// Global history can span many Chats. Serialize exact reads rather than bursting the server.
let pending: Promise<unknown> = Promise.resolve();
function readReceipts(id: string, communicationEventIds: string[], signal: AbortSignal) {
  const result = pending.then(() => {
    signal.throwIfAborted();
    return api.activeMessageDeliveryReceipts(id, { communicationEventIds, activationIds: [] },
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  });
  pending = result.catch(() => {});
  return result;
}

/** Refresh retained rows without refetching authored history. Each exact read stays bounded. */
export function useMessageDeliveryReceipts<T extends ReceiptSource>(sources: readonly T[], scopeId?: string, enabled = true): T[] {
  const batches = useMemo(() => {
    const byScope = new Map<string, Set<string>>();
    for (const source of sources) {
      const id = source.conversationId ?? source.source?.conversationId ?? scopeId;
      if (!id || !source.communicationEventId) continue;
      if (!byScope.has(id)) byScope.set(id, new Set());
      byScope.get(id)!.add(source.communicationEventId);
    }
    return [...byScope].flatMap(([id, ids]) => {
      const sorted = [...ids].sort();
      return Array.from({ length: Math.ceil(sorted.length / 1_000) }, (_, index) => ({
        id, communicationEventIds: sorted.slice(index * 1_000, (index + 1) * 1_000),
      }));
    });
  }, [sources, scopeId]);
  const items = useQueries({
    queries: batches.map(({ id, communicationEventIds }) => ({
      enabled,
      queryKey: queryKeys.conversations.activeDeliveryReceipts(id, communicationEventIds.join("\0"), ""),
      queryFn: ({ signal }: { signal: AbortSignal }) => readReceipts(id, communicationEventIds, signal),
      // Workspace SSE is primary; visible-only polling repairs a missed event.
      refetchInterval: (query: { state: { data?: ActiveMessageDeliveryReceiptsDto } }) =>
        !query.state.data || query.state.data.items.some(item => item.deliveryReceipts.some(receipt =>
          receipt.runStopState === "stopping" || !["processed", "recovered", "undelivered", "retry_exhausted", "failed", "cancelled", "run_unconfirmed"].includes(receipt.state)))
          ? 5_000 : false,
      refetchIntervalInBackground: false,
    })),
    combine,
  });
  const previous = useRef<T[]>([]);
  return useMemo(() => {
    previous.current = projectMessageDeliveryReceipts(sources, items, previous.current);
    return previous.current;
  }, [sources, items]);
}
