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
}

export function createDeliveryOperationTracker(
  delivery: "steer" | "queue",
  agentIds: readonly string[],
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>,
  initiatedAt = Date.now(),
): ActiveOperationTracker | undefined {
  return delivery === "steer" && agentIds.length > 0
    ? createActiveOperationTracker(
        "delivery",
        agentIds,
        healthByAgentId,
        initiatedAt,
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
): ActiveOperationTracker {
  return {
    kind,
    initiatedAt,
    expiresAt: initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS,
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

/** Bind an accepted delivery to only the execution it causally reached. Once
 * bound, an execution-ID change is terminal so a later unrelated Run cannot
 * inherit the old Composer's Stop control. */
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
    if (target.receiptConfirmed) {
      if (activity?.executionId === target.matchedExecutionId) {
        return [target];
      }
      changed = true;
      return [];
    }
    if (receipt?.executionId) {
      if (
        activity &&
        receiptSucceeded(receipt.state) &&
        receipt.executionId === activity.executionId
      ) {
        changed = true;
        return [{
          ...target,
          matchedExecutionId: activity.executionId,
          receiptConfirmed: true as const,
        }];
      }
      if (target.matchedExecutionId) {
        changed = true;
        return [{ ...target, matchedExecutionId: undefined }];
      }
    } else if (target.matchedExecutionId) {
      if (activity?.executionId === target.matchedExecutionId) return [target];
      if (now >= tracker.expiresAt) {
        changed = true;
        return [];
      }
      changed = true;
      return [{ ...target, matchedExecutionId: undefined }];
    }
    if (!activity) {
      if (now >= tracker.expiresAt) {
        changed = true;
        return [];
      }
      return [target];
    }
    const causallyStarted = tracker.kind === "creation"
      ? Date.parse(activity.startedAt) >= tracker.initiatedAt
      : Boolean(receipt && receiptSucceeded(receipt.state) &&
          receipt.executionId === activity.executionId);
    if (!causallyStarted) {
      if (now >= tracker.expiresAt) {
        changed = true;
        return [];
      }
      return [target];
    }
    changed = true;
    return [{
      ...target,
      ...(receipt?.activationId ? { activationId: receipt.activationId } : {}),
      matchedExecutionId: activity.executionId,
      receiptConfirmed: true as const,
    }];
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
