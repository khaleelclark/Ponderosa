import { TERMINAL_REQUEST_STATES, type CoordinationRequestState } from "@ponderosa/core";

function terminalAt(state: CoordinationRequestState, now: string): string | null {
  return TERMINAL_REQUEST_STATES.has(state) ? now : null;
}

export { terminalAt };
