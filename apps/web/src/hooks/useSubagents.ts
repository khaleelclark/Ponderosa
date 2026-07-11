import type { SubagentRunDto } from "@ponderosa/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  applyCancellationResult,
  applySubagentEnvelope,
  emptySubagentStore,
  hydrateSubagentStore,
  type SubagentStore,
  type SubagentUiBinding,
} from "../subagents";

const cursors = new Map<string, number>();

export function useSubagents(masterChatId: string, enabled: boolean): SubagentUiBinding | undefined {
  const [store, setStore] = useState<SubagentStore>(emptySubagentStore);
  const storeRef = useRef(store);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());

  const update = useCallback((next: SubagentStore | ((current: SubagentStore) => SubagentStore)) => {
    setStore((current) => {
      const value = typeof next === "function" ? next(current) : next;
      storeRef.current = value;
      return value;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let close: (() => void) | undefined;
    void api.listSubagents(masterChatId).then((runs) => {
      if (!active) return;
      const hydrated = hydrateSubagentStore(runs);
      hydrated.lastSeq = cursors.get(masterChatId) ?? 0;
      update(hydrated);
      const subscription = api.subscribeSubagents(masterChatId, hydrated.lastSeq || undefined, {
        onEvent(envelope) {
          if (!active) return;
          cursors.set(masterChatId, Math.max(cursors.get(masterChatId) ?? 0, envelope.seq));
          update((current) => applySubagentEnvelope(current, envelope));
        },
      });
      close = () => subscription.close();
    });
    return () => { active = false; close?.(); };
  }, [enabled, masterChatId, update]);

  const cancel = useCallback(async (run: SubagentRunDto) => {
    setCancelling((current) => new Set(current).add(run.id));
    try {
      const result = await api.cancelSubagent(run.id, {
        scope: "branch",
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${run.id}`,
      });
      update((current) => applyCancellationResult(current, result));
    } finally {
      setCancelling((current) => { const next = new Set(current); next.delete(run.id); return next; });
    }
  }, [update]);

  return enabled ? { store, cancelling, cancel } : undefined;
}
