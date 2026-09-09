import type { AgentHealthDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { createClientId } from "../clientId";
import {
  activeOperationExecutionTargets,
  activeOperationsForScope,
  activeOperationIsRunning,
  activeOperationNeedsExpiryTimer,
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
  healthByAgentId,
  receiptSources,
  agentTitle,
  invalidate,
}: {
  activeScopeId?: string;
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>;
  receiptSources: readonly ReceiptSource[];
  agentTitle(agentId: string | undefined): string;
  invalidate(): void;
}) {
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
  const receipts = useMemo<ActiveOperationReceipt[]>(
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

  const scopedOperations = activeOperationsForScope(
    activeOperations,
    activeScopeId,
  );
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
    operationRunning: scopedOperations.some(activeOperationIsRunning),
    cancelOperationError,
    cancelOperationPending,
    cancelOperationTargets,
    stopConfirmation,
    setStopConfirmation,
    stopOperation,
  };
}
