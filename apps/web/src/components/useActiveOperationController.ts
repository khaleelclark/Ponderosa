import type { AgentHealthDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { backgroundCooldownRemaining } from "../api/backgroundCooldown";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {
  activeOperationExecutionTargets,
  activeOperationAgentPhase,
  activeOperationReceiptIdentity,
  activeOperationsForScope,
  activeOperationIsRunning,
  activeOperationNeedsExpiryTimer,
  mergeActiveOperationReceipts,
  retainActiveOperation,
  reconcileActiveOperationTracker,
  type ActiveOperationReceipt,
  type ActiveOperationTracker,
} from "./activeOperationTracker";

interface ReceiptSource {
  communicationEventId?: string;
  deliveryReceipts?: MessageDeliveryReceiptDto[];
}

export function useActiveOperationController({
  activeScopeId,
  healthProjectId,
  healthByAgentId,
  receiptSources,
  agentTitle,
  invalidate,
}: {
  activeScopeId?: string;
  healthProjectId?: string;
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>;
  receiptSources: readonly ReceiptSource[];
  agentTitle(agentId: string | undefined): string;
  invalidate(): void;
}) {
  const queryClient = useQueryClient();
  const [activeOperations, setActiveOperations] =
    useState<ActiveOperationTracker[]>([]);
  const [stopConfirmation, setStopConfirmation] = useState<{
    targets: { agentId: string; runId: string }[];
    names: string;
  }>();
  const [cancelOperationPending, setCancelOperationPending] = useState(false);
  const [cancelOperationError, setCancelOperationError] = useState<Error>();
  const stopOperationRequestIds = useRef<Map<string, string>>(new Map());
  const stopOperationPending = useRef(false);
  const scopedOperations = activeOperationsForScope(
    activeOperations,
    activeScopeId,
  );
  const activeReceiptIdentity = useMemo(
    () => activeOperationReceiptIdentity(activeOperations, activeScopeId),
    [activeOperations, activeScopeId],
  );
  const exactReceiptsQuery = useQuery({
    queryKey: queryKeys.conversations.activeDeliveryReceipts(
      activeScopeId ?? "",
      activeReceiptIdentity.communicationEventIds.join("\0"),
      activeReceiptIdentity.activationIds.join("\0"),
    ),
    queryFn: () => api.activeMessageDeliveryReceipts(activeScopeId!, activeReceiptIdentity),
    enabled: Boolean(activeScopeId) &&
      (activeReceiptIdentity.communicationEventIds.length > 0 || activeReceiptIdentity.activationIds.length > 0),
    // The workspace stream is primary. A visible, scoped five-second fallback
    // recovers a missed event without reintroducing fast per-Agent polling.
    refetchInterval: scopedOperations.length > 0 ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const paginatedReceipts = useMemo<ActiveOperationReceipt[]>(
    () => receiptSources.flatMap(source =>
      source.communicationEventId
        ? (source.deliveryReceipts ?? []).map(receipt => ({
            communicationEventId: source.communicationEventId!,
            receipt,
          }))
        : []
    ),
    [receiptSources],
  );
  const receipts = useMemo<ActiveOperationReceipt[]>(() => mergeActiveOperationReceipts(
    (exactReceiptsQuery.data?.items ?? []).flatMap(source =>
      source.deliveryReceipts.map(receipt => ({
        communicationEventId: source.communicationEventId,
        receipt,
      }))
    ),
    paginatedReceipts,
  ), [exactReceiptsQuery.data?.items, paginatedReceipts]);
  const operationPhaseByAgentId = useMemo(() => {
    const phases = new Map<string, ReturnType<typeof activeOperationAgentPhase>>();
    const agentIds = new Set(scopedOperations.flatMap(operation =>
      operation.targets.map(target => target.agentId)
    ));
    for (const agentId of agentIds) {
      phases.set(agentId, activeOperationAgentPhase(
        scopedOperations, agentId, healthByAgentId.get(agentId), receipts,
      ));
    }
    return phases;
  }, [healthByAgentId, receipts, scopedOperations]);
  const awaitingCanonicalHealth = [...operationPhaseByAgentId.values()]
    .some(phase => phase === "preparing");

  useEffect(() => {
    if (!awaitingCanonicalHealth || !healthProjectId) return;
    const refresh = () => {
      if (document.visibilityState !== "visible" || backgroundCooldownRemaining() > 0) return;
      const queryKey = queryKeys.agents.health(healthProjectId);
      if (queryClient.isFetching({ queryKey, exact: true }) > 0 ||
          Date.now() - (queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0) < 5_000) return;
      void queryClient.refetchQueries({
        queryKey,
        exact: true,
        type: "active",
      }, { cancelRefetch: false });
    };
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [awaitingCanonicalHealth, healthProjectId, queryClient]);

  useEffect(() => {
    if (!activeOperations.length) return;
    const reconciled = activeOperations.flatMap(operation => {
      const next = reconcileActiveOperationTracker(
        operation,
        healthByAgentId,
        receipts,
      );
      return next ? [next] : [];
    });
    if (reconciled.some((operation, index) => operation !== activeOperations[index]) ||
        reconciled.length !== activeOperations.length) {
      setActiveOperations(reconciled);
      return;
    }
    const nextExpiry = activeOperations
      .filter(activeOperationNeedsExpiryTimer)
      .map(operation => operation.expiresAt)
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const delay = Math.max(0, nextExpiry - Date.now());
    const timeout = window.setTimeout(() => {
      setActiveOperations(current => current.flatMap(operation => {
        const next = reconcileActiveOperationTracker(
          operation,
          healthByAgentId,
          receipts,
        );
        return next ? [next] : [];
      }));
    }, delay + 1);
    return () => window.clearTimeout(timeout);
  }, [activeOperations, healthByAgentId, receipts]);

  useEffect(() => {
    setStopConfirmation(undefined);
    setCancelOperationError(undefined);
  }, [activeScopeId]);

  const trackActiveOperation = (operation: ActiveOperationTracker | undefined) => {
    if (!operation) return;
    setActiveOperations(current => retainActiveOperation(current, operation));
  };
  const cancelOperationTargets = async (
    targets: { agentId: string; runId: string }[],
  ) => {
    if (stopOperationPending.current) return;
    stopOperationPending.current = true;
    setCancelOperationPending(true);
    setCancelOperationError(undefined);
    const attempts = targets.map(target => {
      const targetKey = `${target.agentId}:${target.runId}`;
      const idempotencyKey =
        stopOperationRequestIds.current.get(targetKey) ?? createClientId();
      stopOperationRequestIds.current.set(targetKey, idempotencyKey);
      return { target, targetKey, idempotencyKey };
    });
    try {
      const results = await Promise.allSettled(
        attempts.map(({ target, idempotencyKey }) =>
          api.cancelRun(target.agentId, {
            targetRunId: target.runId,
            idempotencyKey,
          }),
        ),
      );
      const unresolved: { agentId: string; runId: string }[] = [];
      let unresolvedError: Error | undefined;
      results.forEach((result, index) => {
        const attempt = attempts[index]!;
        const alreadyInactive =
          result.status === "rejected" &&
          result.reason instanceof ApiRequestError &&
          result.reason.status === 409;
        if (result.status === "fulfilled" || alreadyInactive) {
          stopOperationRequestIds.current.delete(attempt.targetKey);
          return;
        }
        unresolved.push(attempt.target);
        unresolvedError ??= result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));
      });
      if (unresolved.length === 0) {
        setStopConfirmation(undefined);
        setCancelOperationError(undefined);
      } else {
        setStopConfirmation(current => current
          ? {
              targets: unresolved,
              names: unresolved.map(({ agentId }) => agentTitle(agentId)).join(", "),
            }
          : current);
        setCancelOperationError(unresolvedError);
      }
    } finally {
      stopOperationPending.current = false;
      setCancelOperationPending(false);
      invalidate();
    }
  };

  const stopOperation = async () => {
    if (stopOperationPending.current) return;
    const targets = [...new Map(scopedOperations.flatMap(
      activeOperationExecutionTargets,
    ).map(target => [`${target.agentId}:${target.runId}`, target] as const)).values()].filter(
      ({ agentId, runId }) =>
        healthByAgentId.get(agentId)?.runtimeActivity?.executionId === runId,
    );
    if (targets.length === 0) return;
    setCancelOperationError(undefined);
    const names = targets.map(({ agentId }) => agentTitle(agentId)).join(", ");
    if (targets.length > 1) {
      setStopConfirmation({ targets, names });
      return;
    }
    await cancelOperationTargets(targets);
  };

  return {
    activeOperations,
    setActiveOperation: trackActiveOperation,
    operationPhaseByAgentId,
    operationRunning: scopedOperations.some(activeOperationIsRunning),
    cancelOperationError,
    cancelOperationPending,
    cancelOperationTargets,
    stopConfirmation,
    setStopConfirmation,
    stopOperation,
  };
}
