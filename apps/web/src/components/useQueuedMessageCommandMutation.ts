import { useMutation } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import { createClientId } from "../clientId";
import { runQueuedMessageCommand, type QueuedMessageCommandAttemptRegistry, type QueuedMessageCommandInput } from "./queuedMessageCommandAttempts";

export interface QueuedMessageCommandFailure {
  error: Error;
  deliveryId: string;
  retry(): void;
}

/** Surfaces own scope, query and attempt lifetime; commands share exact retry handling. */
export function useQueuedMessageCommandMutation<Variables extends string | { deliveryId: string }, Response>({
  attempts, input, dispatch, invalidate, onFailure, onSuccess,
}: {
  attempts: MutableRefObject<QueuedMessageCommandAttemptRegistry>;
  input(variables: Variables): QueuedMessageCommandInput;
  dispatch(variables: Variables, request: { idempotencyKey: string; canonicalText?: string }): Promise<Response>;
  invalidate(): void;
  onFailure(failure?: QueuedMessageCommandFailure): void;
  onSuccess?(response: Response, variables: Variables): void;
}) {
  const mutation = useMutation({
    mutationFn: (variables: Variables) => {
      const command = input(variables);
      return runQueuedMessageCommand(attempts.current, command,
        () => command.command === "edit" ? createClientId() : `${command.command}:${command.deliveryId}`,
        request => dispatch(variables, request));
    },
    onMutate: () => onFailure(undefined),
    onSuccess: (response, variables) => { invalidate(); onSuccess?.(response, variables); },
    onError: (error, variables) => {
      onFailure({ error: error instanceof Error ? error : new Error(String(error)),
        deliveryId: typeof variables === "string" ? variables : variables.deliveryId, retry: () => mutation.mutate(variables) });
      invalidate();
    },
  });
  return mutation;
}
