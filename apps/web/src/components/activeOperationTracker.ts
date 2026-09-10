import type {
  AgentHealthDto,
  MessageDeliveryReceiptDto,
  MultiAgentDirectMessageResponse,
} from "@ponderosa/core";

export const ACTIVE_OPERATION_START_TIMEOUT_MS = 60_000;

export interface ActiveOperationTarget {
  agentId: string;
  activationId?: string;
  matchedExecutionId?: string;
  receiptConfirmed?: true;
}

export interface ActiveOperationTracker {
  kind: "creation" | "delivery";
  targets: ActiveOperationTarget[];
  initiatedAt: number;
  expiresAt: number;
  communicationEventId?: string;
  scopeId?: string;
}

export function createDeliveryOperationTracker(
  delivery: "steer" | "queue",
  agentIds: readonly string[],
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>,
  initiatedAt = Date.now(),
  scopeId?: string,
): ActiveOperationTracker | undefined {
  return delivery === "steer" && agentIds.length > 0
    ? createActiveOperationTracker(
        "delivery",
        agentIds,
        healthByAgentId,
        initiatedAt,
        scopeId,
      )
    : undefined;
}

const receiptSucceeded = (state: MessageDeliveryReceiptDto["state"]): boolean =>
  ["steering", "started", "delivered"].includes(state);

const receiptTerminal = (state: MessageDeliveryReceiptDto["state"]): boolean =>
  [
    "processed",
    "recovered",
    "undelivered",
    "retry_exhausted",
    "failed",
    "cancelled",
  ].includes(state);

export function createActiveOperationTracker(
  kind: ActiveOperationTracker["kind"],
  agentIds: readonly string[],
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>,
  initiatedAt = Date.now(),
  scopeId?: string,
): ActiveOperationTracker {
  return {
    kind,
    initiatedAt,
    expiresAt: initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS,
    ...(scopeId ? { scopeId } : {}),
    targets: [...new Set(agentIds)].map(agentId => {
      const executionId = healthByAgentId.get(agentId)?.runtimeActivity?.executionId;
      return {
        agentId,
        ...(executionId ? {
          matchedExecutionId: executionId,
        } : {}),
      };
    }),
  };
}

export function createCreationOperationTracker(
  agentId: string,
  scopeId?: string,
  initiatedAt = Date.now(),
): ActiveOperationTracker {
  return {
    kind: "creation",
    initiatedAt,
    expiresAt: initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS,
    communicationEventId: `agent-opening:${agentId}`,
    ...(scopeId ? { scopeId } : {}),
    targets: [{ agentId }],
  };
}

export function createQueuedSteerOperationTracker(
  deliveryId: string,
  agentId: string,
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>,
  scopeId: string,
  initiatedAt = Date.now(),
): ActiveOperationTracker {
  const tracker = createActiveOperationTracker(
    "delivery",
    [agentId],
    healthByAgentId,
    initiatedAt,
    scopeId,
  );
  tracker.targets[0]!.activationId = deliveryId;
  return tracker;
}

export function acceptDirectOperation(
  tracker: ActiveOperationTracker,
  response: MultiAgentDirectMessageResponse,
): ActiveOperationTracker | undefined {
  const accepted = new Map(response.recipients.map(recipient => [
    recipient.agentId,
    recipient,
  ]));
  const targets = tracker.targets.flatMap(target => {
    const recipient = accepted.get(target.agentId);
    if (
      !recipient ||
      ["failed", "outcome_unknown", "cancelled", "delivered"].includes(
        recipient.state ?? "",
      )
    ) return [];
    return [{
      ...target,
      ...(recipient.deliveryId ? { activationId: recipient.deliveryId } : {}),
    }];
  });
  return targets.length ? { ...tracker, targets } : undefined;
}

export function acceptBroadcastOperation(
  tracker: ActiveOperationTracker,
  communicationEventId: string | undefined,
): ActiveOperationTracker | undefined {
  return communicationEventId
    ? { ...tracker, communicationEventId }
    : undefined;
}

export interface ActiveOperationReceipt {
  communicationEventId: string;
  receipt: MessageDeliveryReceiptDto;
}

/** Exact active-operation refreshes override a stale copy from message pagination. */
export function mergeActiveOperationReceipts(
  authoritative: readonly ActiveOperationReceipt[],
  paginated: readonly ActiveOperationReceipt[],
): ActiveOperationReceipt[] {
  const exact = new Set(authoritative.map(entry =>
    `${entry.communicationEventId}\0${entry.receipt.activationId}`
  ));
  return [
    ...authoritative,
    ...paginated.filter(entry => !exact.has(
      `${entry.communicationEventId}\0${entry.receipt.activationId}`,
    )),
  ];
}

const recoveryTransition = (state: MessageDeliveryReceiptDto["state"]): boolean =>
  ["recovery_queued", "recovering", "recovered"].includes(state);

function activeReceiptExecutionId(
  receipt: MessageDeliveryReceiptDto,
): string | undefined {
  if (receipt.state === "recovering") return receipt.recoveryExecutionId;
  if (["unconfirmed", "waiting_for_run"].includes(receipt.state)) {
    return receipt.executionId;
  }
  return receiptSucceeded(receipt.state) ? receipt.executionId : undefined;
}

/** Bind an accepted delivery only to the execution it causally reached. A
 * recovery may replace that execution only when its exact lineage is projected. */
export function reconcileActiveOperationTracker(
  tracker: ActiveOperationTracker,
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>,
  receipts: readonly ActiveOperationReceipt[],
  now = Date.now(),
): ActiveOperationTracker | undefined {
  let changed = false;
  const targets = tracker.targets.flatMap(target => {
    const health = healthByAgentId.get(target.agentId);
    const activity = health?.runtimeActivity;
    const receiptEntry = receipts.find(entry =>
      entry.receipt.targetAgentId === target.agentId &&
      (target.activationId
        ? entry.receipt.activationId === target.activationId
        : tracker.communicationEventId === entry.communicationEventId));
    const receipt = receiptEntry?.receipt;
    if (receipt && receiptTerminal(receipt.state)) {
      changed = true;
      return [];
    }
    const receiptExecutionId = receipt
      ? activeReceiptExecutionId(receipt)
      : undefined;
    if (receiptExecutionId) {
      if (activity?.executionId === receiptExecutionId) {
        if (
          target.matchedExecutionId === receiptExecutionId &&
          target.receiptConfirmed
        ) return [target];
        changed = true;
        return [{
          ...target,
          matchedExecutionId: receiptExecutionId,
          receiptConfirmed: true as const,
        }];
      }
      if (target.matchedExecutionId) {
        changed = true;
        return [{
          ...target,
          matchedExecutionId: undefined,
          receiptConfirmed: undefined,
        }];
      }
      return [target];
    }
    if (target.matchedExecutionId) {
      if (
        activity?.executionId === target.matchedExecutionId &&
        (!receipt || !recoveryTransition(receipt.state))
      ) return [target];
      if (!target.activationId && !tracker.communicationEventId &&
          now >= tracker.expiresAt) {
        changed = true;
        return [];
      }
      changed = true;
      return [{
        ...target,
        matchedExecutionId: undefined,
        receiptConfirmed: undefined,
      }];
    }
    const canonicallyAttributed = Boolean(
      target.activationId || tracker.communicationEventId,
    );
    if (!canonicallyAttributed && now >= tracker.expiresAt) {
      changed = true;
      return [];
    }
    // Pending trackers never claim a later Run merely because clocks appear
    // ordered; canonical receipts are the only authority for a new binding.
    return [target];
  });
  if (!targets.length) return undefined;
  return changed ? { ...tracker, targets } : tracker;
}

export const activeOperationExecutionTargets = (
  tracker: ActiveOperationTracker | undefined,
): Array<{ agentId: string; runId: string }> => tracker?.targets.flatMap(target =>
  target.matchedExecutionId
    ? [{ agentId: target.agentId, runId: target.matchedExecutionId }]
    : []) ?? [];

export const activeOperationIsRunning = (
  tracker: ActiveOperationTracker | undefined,
): boolean => Boolean(tracker?.targets.some(target => target.matchedExecutionId));

export const activeOperationNeedsExpiryTimer = (
  tracker: ActiveOperationTracker,
): boolean => !tracker.communicationEventId && tracker.targets.some(target =>
  !target.activationId && !target.matchedExecutionId
);

export const activeOperationForScope = (
  tracker: ActiveOperationTracker | undefined,
  scopeId: string | undefined,
): ActiveOperationTracker | undefined =>
  tracker && (!tracker.scopeId || tracker.scopeId === scopeId)
    ? tracker
    : undefined;

export function activeOperationKey(tracker: ActiveOperationTracker): string {
  if (tracker.communicationEventId) {
    return `communication:${tracker.communicationEventId}`;
  }
  const activationIds = tracker.targets.flatMap(target =>
    target.activationId ? [target.activationId] : []
  ).sort();
  return activationIds.length === tracker.targets.length
    ? `activations:${activationIds.join(",")}`
    : `pending:${tracker.scopeId ?? "workspace"}:${tracker.kind}:${tracker.initiatedAt}`;
}

export function retainActiveOperation(
  trackers: readonly ActiveOperationTracker[],
  tracker: ActiveOperationTracker | undefined,
): ActiveOperationTracker[] {
  if (!tracker) return [...trackers];
  const key = activeOperationKey(tracker);
  return [
    ...trackers.filter(candidate => activeOperationKey(candidate) !== key),
    tracker,
  ];
}

export const activeOperationsForScope = (
  trackers: readonly ActiveOperationTracker[],
  scopeId: string | undefined,
): ActiveOperationTracker[] => trackers.filter(tracker =>
  Boolean(activeOperationForScope(tracker, scopeId))
);

export function activeOperationReceiptIdentity(
  trackers: readonly ActiveOperationTracker[],
  scopeId: string | undefined,
): { communicationEventIds: string[]; activationIds: string[] } {
  const scoped = activeOperationsForScope(trackers, scopeId);
  return {
    communicationEventIds: [...new Set(scoped.flatMap(operation =>
      operation.communicationEventId ? [operation.communicationEventId] : []
    ))].sort(),
    activationIds: [...new Set(scoped.flatMap(operation =>
      operation.targets.flatMap(target => target.activationId ? [target.activationId] : [])
    ))].sort(),
  };
}
