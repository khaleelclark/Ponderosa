import type { AssignmentDto } from "@ponderosa/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  applyCancellationResult,
  applyAssignmentEnvelope,
  emptyAssignmentStore,
  hydrateAssignmentStore,
  type AssignmentStore,
  type AssignmentUiBinding,
} from "../assignments";

const cursors = new Map<string, number>();

export function useAssignments(masterChatId: string, enabled: boolean): AssignmentUiBinding | undefined {
  const [store, setStore] = useState<AssignmentStore>(emptyAssignmentStore);
  const storeRef = useRef(store);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());

  const update = useCallback((next: AssignmentStore | ((current: AssignmentStore) => AssignmentStore)) => {
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
    void api.listAssignments(masterChatId).then((runs) => {
      if (!active) return;
      const hydrated = hydrateAssignmentStore(runs);
      hydrated.lastSeq = cursors.get(masterChatId) ?? 0;
      update(hydrated);
      const subscription = api.subscribeAssignments(masterChatId, hydrated.lastSeq || undefined, {
        onEvent(envelope) {
          if (!active) return;
          cursors.set(masterChatId, Math.max(cursors.get(masterChatId) ?? 0, envelope.seq));
          update((current) => applyAssignmentEnvelope(current, envelope));
        },
      });
      close = () => subscription.close();
    });
    return () => { active = false; close?.(); };
  }, [enabled, masterChatId, update]);

  const cancel = useCallback(async (run: AssignmentDto) => {
    setCancelling((current) => new Set(current).add(run.id));
    try {
      const result = await api.cancelAssignment(run.id, {
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
