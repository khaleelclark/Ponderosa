import { canonicalizeProviderText } from "@ponderosa/core";
import {
  retainIdempotentAttempt,
  type IdempotentAttempt,
} from "./idempotentAttempt.js";

export type QueuedMessageCommandAttempt = IdempotentAttempt<undefined>;
export type QueuedMessageCommandAttemptRegistry = Map<
  string,
  QueuedMessageCommandAttempt
>;

export type QueuedMessageCommandInput =
  | { command: "cancel" | "steer"; deliveryId: string }
  | { command: "edit"; deliveryId: string; text: string };

export function retainQueuedMessageCommandAttempt(
  registry: QueuedMessageCommandAttemptRegistry,
  input: QueuedMessageCommandInput,
  createId: () => string,
): {
  slot: string;
  attempt: QueuedMessageCommandAttempt;
  canonicalText?: string;
} {
  const slot = JSON.stringify([input.command, input.deliveryId]);
  const canonicalText = input.command === "edit"
    ? canonicalizeProviderText(input.text).trim()
    : undefined;
  const fingerprint = JSON.stringify([
    input.command,
    input.deliveryId,
    canonicalText ?? null,
  ]);
  const attempt = retainIdempotentAttempt(
    registry.get(slot),
    fingerprint,
    createId,
    () => undefined,
  );
  registry.set(slot, attempt);
  return {
    slot,
    attempt,
    ...(canonicalText !== undefined ? { canonicalText } : {}),
  };
}

export function completeQueuedMessageCommandAttempt(
  registry: QueuedMessageCommandAttemptRegistry,
  slot: string,
  attempt: QueuedMessageCommandAttempt,
): void {
  if (registry.get(slot) === attempt) registry.delete(slot);
}

/** Retain ambiguous failures and clear only after the exact command resolves. */
export async function runQueuedMessageCommand<T>(
  registry: QueuedMessageCommandAttemptRegistry,
  input: QueuedMessageCommandInput,
  createId: () => string,
  dispatch: (request: {
    idempotencyKey: string;
    canonicalText?: string;
  }) => Promise<T>,
): Promise<T> {
  const retained = retainQueuedMessageCommandAttempt(
    registry,
    input,
    createId,
  );
  const response = await dispatch({
    idempotencyKey: retained.attempt.idempotencyKey,
    ...(retained.canonicalText !== undefined
      ? { canonicalText: retained.canonicalText }
      : {}),
  });
  completeQueuedMessageCommandAttempt(
    registry,
    retained.slot,
    retained.attempt,
  );
  return response;
}
