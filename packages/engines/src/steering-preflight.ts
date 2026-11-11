import type { RuntimeTurnInput } from "@ponderosa/core";

/** Thrown by the host only when this exact Run or session has lost authority. */
export class SteeringAuthorityChangedError extends Error {}

/** Called only before a built-in adapter submits the steering input. */
export function steeringPreflight(input: RuntimeTurnInput): boolean {
  try {
    input.assertCurrent?.();
    return true;
  } catch (error) {
    if (error instanceof SteeringAuthorityChangedError) return false;
    throw error;
  }
}
